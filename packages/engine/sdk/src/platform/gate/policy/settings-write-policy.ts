/**
 * settings-write-policy.ts, what the Agent may set, and the writes that need
 * the user to say so first. Hoisted from the agent
 * (src/tools/agent-settings-write-policy.ts) into the engine gate.
 *
 * Read under the owner ruling of 2026-09-27: the frozen list of eleven key
 * names decided "is an unattended write of this key a hazard", a judgment made
 * by name, and a non-empty `explicitUserRequest` decided "did the user ask for
 * it", which any text satisfied. Both are now the `engine.gate.settings-hazard`
 * reading (gate/batteries/settings-hazard.ts). The three hazard classes, and
 * the rule that everything else is set on request, are unchanged.
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
 * The exposure half becomes the settings-hazard reading: whether an unattended
 * write is itself the hazard, in exactly three classes:
 *
 *   1. approval gates the Agent would otherwise be granting itself,
 *   2. the exec sandbox that contains what the Agent runs,
 *   3. moving a loopback listener onto the network, or widening who it trusts.
 *
 * Everything else the Agent sets on request. The classes must not grow into a
 * general "settings the model shouldn't touch" policy.
 *
 * ## Nothing fails silently
 *
 * A gated key is not refused, it is *deferred to the user*, loudly. The denial
 * names the key, states the hazard in plain language, and says exactly what
 * would let it proceed. Silence dressed as success is the whole reason this file
 * exists.
 */

import type { Tool } from '../../types/tools.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { settingsHazard, type SettingsHazard } from '../batteries/settings-hazard.js';

/** Why an unattended write in each hazard class is the hazard, in the user's language. */
const HAZARD_BECAUSE: Readonly<Record<Exclude<SettingsHazard, 'none'>, string>> = {
  'approval-gate': 'it changes which actions run without asking you, so the Agent would be granting itself permission',
  'exec-containment': 'it changes the sandbox that contains commands run from here',
  'host-exposure': 'it changes how this machine is exposed to the network or which hosts are trusted or reachable',
};

/** The decision site settings-write readings are logged under. */
export const SETTINGS_HAZARD_SITE = 'engine.gate.settings-write';

/** Parameter carrying the user's own words when a gated key is being set. */
export const AGENT_SETTINGS_CONFIRMATION_PROPERTY = 'explicitUserRequest';

/** Loud, self-explaining denial. Never returned as, or alongside, a success. */
export function describeConfirmationRequiredDenial(hazard: Exclude<SettingsHazard, 'none'>, key: string): string {
  return [
    `${key} requires your confirmation because ${HAZARD_BECAUSE[hazard]}.`,
    'It was NOT changed, and nothing else was written.',
    `To proceed, say so explicitly and the Agent will retry with ${AGENT_SETTINGS_CONFIRMATION_PROPERTY} set to your request`,
    `(hazard class: ${hazard}).`,
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
 * Deny a hazardous write that the user's own words do not ask for. Returns
 * null, meaning "let it through", for a key with no key, a write Jev reads as
 * no hazard, and a hazardous write whose request asks for it. An uncertain
 * hazard reading counts as a hazard; an uncertain request reading counts as no
 * request.
 */
export async function validateSettingsToolInvocationForAgentPolicy(args: SettingsToolArgs): Promise<string | null> {
  const key = typeof args.key === 'string' ? args.key.trim() : '';
  if (!key) return null;
  const request = args[AGENT_SETTINGS_CONFIRMATION_PROPERTY];
  const hasRequest = typeof request === 'string' && request.trim().length > 0;
  const run = await settingsHazard.run(
    judgmentPort(SETTINGS_HAZARD_SITE),
    { key, value: JSON.stringify(args['value'] ?? null), ...(hasRequest ? { request: (request as string).trim() } : {}) },
    { site: SETTINGS_HAZARD_SITE, only: hasRequest ? ['hazard', 'requested'] : ['hazard'] },
  );
  const reading = run.readings.hazard;
  if (reading.choice === 'none' && reading.outcome === 'act') {
    run.recordAction('no-hazard');
    return null;
  }
  const hazard: Exclude<SettingsHazard, 'none'> = reading.choice === 'none' ? 'approval-gate' : reading.choice;
  if (hasRequest && run.readings.requested.verdict === 'yes') {
    run.recordAction(`requested:${hazard}`);
    return null;
  }
  run.recordAction(`deferred:${hazard}`);
  return describeConfirmationRequiredDenial(hazard, key);
}

/** Description the Agent surface shows for `goodvibes_settings`. */
export const AGENT_SETTINGS_TOOL_DESCRIPTION = [
  'Read and change GoodVibes settings.',
  'When the user gives you a concrete configuration value, a bot username, a chat id, a host, a port, a model, a path, that is a request to apply it:',
  'set it, then tell them the key and the persistedTo store it landed in. A value you only repeat back in prose has not been set.',
  'Writes route to the runtime that owns the key, so daemon-owned settings (surfaces.*, control-plane binding, watchers, device pairing, provisioning, retention) land in the daemon config and take effect there,',
  'while Agent-owned settings stay in the Agent config. The value is re-read from that store afterwards, so a write that did not land is reported as a failure rather than as success.',
  'If you cannot tell which key a value belongs to, ask one short question instead of guessing, and never set anything the user did not ask for.',
  `Changes that turn off approval gates, weaken the exec sandbox, or expose this host to the network need the user to ask for them first; pass their request in ${AGENT_SETTINGS_CONFIRMATION_PROPERTY} and the refusal will tell you which key and why.`,
  'Raw secrets are refused: store the secret and set the key to a goodvibes:// reference.',
].join(' ');

/**
 * Let the Agent read and write settings, deferring to the user only the writes
 * the settings-hazard reading finds hazardous.
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
        'The user\'s own words asking for this change. Required only for changes that turn off approval gates, weaken the exec sandbox, or expose this host to the network. Never invent it.',
    };
  }

  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args) => {
    const denial = await validateSettingsToolInvocationForAgentPolicy(args as SettingsToolArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(args);
  };
}
