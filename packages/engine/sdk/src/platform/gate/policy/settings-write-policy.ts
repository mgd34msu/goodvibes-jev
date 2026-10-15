/** Agent settings writes use the configured tool permissions and native settings validation. */
import { captureOwnedJson } from '../judgment-input.js';
import { executePolicyCheck } from '../execute-policy-check.js';
import type { Tool } from '../../types/tools.js';
import { isValidConfigKey } from '../../config/schema.js';
import { assertAdmittedAgentSettings } from '../../tools/goodvibes-runtime/settings-admission.js';
import type { SettingsHazard } from '../batteries/settings-hazard.js';
import {
  AGENT_SETTINGS_CONFIRMATION_PROPERTY, type SettingsToolArgs,
} from './settings-write-evidence.js';
export { AGENT_SETTINGS_CONFIRMATION_PROPERTY, SETTINGS_HAZARD_SITE, type SettingsToolArgs } from './settings-write-evidence.js';

/** Why an unattended write in each hazard class is the hazard, in the user's language. */
const HAZARD_BECAUSE: Readonly<Record<Exclude<SettingsHazard, 'none'>, string>> = {
  'approval-gate': 'it changes which actions run without asking you, so the Agent would be granting itself permission',
  'exec-containment': 'it changes the sandbox that contains commands run from here',
  'host-exposure': 'it changes how this machine is exposed to the network or which hosts are trusted or reachable',
};

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

/** Compatibility validator; schema and configured permissions own execution. */
export async function validateSettingsToolInvocationForAgentPolicy(_args: SettingsToolArgs, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  return null;
}

/** Description the Agent surface shows for `goodvibes_settings`. */
export const AGENT_SETTINGS_TOOL_DESCRIPTION = [
  'Read and change GoodVibes settings.',
  'When the user gives you a concrete configuration value, a bot username, a chat id, a host, a port, a model, a path, that is a request to apply it:',
  'set it, then tell them the key and the persistedTo store it landed in. A value you only repeat back in prose has not been set.',
  'Writes route to the runtime that owns the key, so daemon-owned settings (surfaces.*, control-plane binding, watchers, device pairing, provisioning, retention) land in the daemon config and take effect there,',
  'while Agent-owned settings stay in the Agent config. The value is re-read from that store afterwards, so a write that did not land is reported as a failure rather than as success.',
  'If you cannot tell which key a value belongs to, ask one short question instead of guessing, and never set anything the user did not ask for.',
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
  tool.execute = async (args, options) => {
    options?.signal?.throwIfAborted();
    const invocation = captureOwnedJson(args) as Record<string, unknown>;
    const denial = await executePolicyCheck(() => validateSettingsToolInvocationForAgentPolicy(invocation, options?.signal), options?.signal);
    if (denial) return { success: false, error: denial };
    options?.signal?.throwIfAborted();
    return originalExecute(invocation, options);
  };
}

/** Mechanical explanation only. Passing it never authorizes a settings effect. */
export function validateAgentSettingsMechanics(args: SettingsToolArgs): string | null {
  if (args.mode !== 'set' && args.mode !== 'reset') return 'Settings accepts only set or reset.';
  if (typeof args.key !== 'string' || !isValidConfigKey(args.key.trim())) return 'Settings requires a registered key.';
  if (args['confirm'] !== true) return 'Settings requires confirm=true.';
  return null;
}

/** Adopted Agent surface: the same recorded admission owns hazard/request judgment. */
export function wrapSettingsToolForAdmittedAgentPolicy(tool: Tool): void {
  tool.definition.description = [
    'Apply or reset a GoodVibes setting through its actual owning runtime.',
    'Writes use the configured tool permissions and the owning runtime’s settings validation.',
    'Raw credentials are refused; use an existing goodvibes:// secret reference or clear the setting.',
  ].join(' ');
  const properties = tool.definition.parameters.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    (properties as Record<string, unknown>)[AGENT_SETTINGS_CONFIRMATION_PROPERTY] = {
      type: 'string', description: 'Optional request context. This text is not authority and does not replace the original host request.',
    };
  }
  const original = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    const problem = validateAgentSettingsMechanics(args);
    if (problem) return { success: false, error: problem };
    assertAdmittedAgentSettings(args, options);
    return original(args, options);
  };
}
