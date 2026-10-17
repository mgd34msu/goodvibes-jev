import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { GATE_PRESETS } from '@goodvibes-jev/engine/sdk/platform/gate';

const BOUNDARY = 'Configured denials and per-call authority checks still apply; this configuration is not a per-call permission decision.';

/** Describe the active automatic permission policy and its explicit constraints. */
export function describePermissionMode(mode: unknown): { readonly label: string; readonly detail: string } {
  if (typeof mode !== 'string' || !Object.values(GATE_PRESETS).some(preset => preset.mode === mode)) {
    return { label: String(mode ?? 'unknown'), detail: `Unrecognized permission mode. ${BOUNDARY}` };
  }
  const label = mode === 'allow-all' ? 'Allow all configured actions'
    : mode === 'prompt' ? 'Automatic actions'
    : mode === 'plan' ? 'Plan only (read-only)'
    : mode === 'accept-edits' ? 'Automatic edits and actions' : 'Custom rules';
  const detail = mode === 'plan' ? 'Read-only mode refuses writes, execution and outward effects.'
    : mode === 'custom' ? 'Explicit tool rules apply; permitted actions run automatically.'
    : 'Permitted actions run automatically without an approval prompt.';
  return { label, detail: `${detail} ${BOUNDARY}` };
}

/** Status observes configuration; doctor explain separately evaluates its exact supplied call. */
export function describeConfiguredPermissions(config: Pick<ConfigManager, 'get'>) {
  if (config.get('behavior.autoApprove') === true) {
    const mode = describePermissionMode(config.get('permissions.mode'));
    return { label: `Auto-approve ON, ${mode.label}`, detail: mode.detail };
  }
  return describePermissionMode(config.get('permissions.mode'));
}
