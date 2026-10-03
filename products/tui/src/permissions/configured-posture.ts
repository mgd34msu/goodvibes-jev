import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { GATE_PRESETS, presetForMode } from '@goodvibes-jev/engine/sdk/platform/gate';

const BOUNDARY = 'The boundary is evaluated first and can still ask or refuse; this configuration is not a per-call permission decision.';

/** Describe the public preset, without promising that a particular call bypasses approval. */
export function describePermissionMode(mode: unknown): { readonly label: string; readonly detail: string } {
  if (typeof mode !== 'string' || !Object.values(GATE_PRESETS).some(preset => preset.mode === mode)) {
    return { label: String(mode ?? 'unknown'), detail: `Unrecognized permission mode. ${BOUNDARY}` };
  }
  const preset = presetForMode(mode);
  const label = mode === 'allow-all' ? 'Automatic below critical stakes'
    : mode === 'prompt' ? 'Ask before powerful actions'
    : mode === 'plan' ? 'Plan only (read-only)'
    : mode === 'accept-edits' ? 'Accept edits under gate limits' : 'Custom rules';
  return { label, detail: `${preset.summary} ${BOUNDARY}` };
}

/** Status observes configuration; doctor explain separately evaluates its exact supplied call. */
export function describeConfiguredPermissions(config: Pick<ConfigManager, 'get'>) {
  if (config.get('behavior.autoApprove') === true) {
    return { label: 'Auto-approve ON, boundary checks still apply', detail: `Calls that pass the boundary are approved automatically. ${BOUNDARY}` };
  }
  return describePermissionMode(config.get('permissions.mode'));
}
