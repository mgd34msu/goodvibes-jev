import { isAutoApproveEnabled } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { presetForMode } from '@goodvibes-jev/engine/sdk/platform/gate';

/**
 * The configured approval posture shared by status, doctor, policy-explain and
 * the footer. This is configuration observability, not a per-call decision:
 * PermissionManager reads each call and enforces the boundary before applying
 * autoApprove, explicit rules or the selected stakes preset.
 *
 * automaticApprovals preserves the broad-autonomy warning for autoApprove,
 * allow-all and custom-all-allow. None guarantees that every call avoids a
 * prompt: critical stakes still ask in allow-all, unknown tools need readings,
 * and boundary approval can be required before any configured allowance.
 */

export type ApprovalPostureKind = 'auto-approve' | 'allow-all' | 'custom' | 'prompt' | 'plan' | 'accept-edits';

export interface ApprovalPostureInput {
  /** behavior.autoApprove, read via the SDK's isAutoApproveEnabled (or an equivalent duck-typed read). */
  readonly autoApprove: boolean;
  /** permissions.mode, as read from config (may be unknown/malformed input from a loose config source). */
  readonly mode: unknown;
  /**
   * permissions.tools, only consulted when mode === 'custom'. Values are the
   * per-tool-category actions ('allow' | 'prompt' | 'deny'); anything else
   * (missing/unrecognized) counts as NOT allow for the autonomy warning.
   */
  readonly customTools?: Readonly<Record<string, unknown>>;
}

export interface ApprovalPosture {
  /** Which precedence branch produced this posture. */
  readonly kind: ApprovalPostureKind;
  /** The raw permissions.mode value, normalized to a known mode string (defaults to 'prompt'). */
  readonly mode: 'prompt' | 'allow-all' | 'custom' | 'plan' | 'accept-edits';
  /** The raw behavior.autoApprove value that drove this posture. */
  readonly autoApprove: boolean;
  /**
   * Broad automatic approvals are configured (autoApprove, allow-all, or every
   * configured custom category allows). Drives the footer's autonomy warning;
   * does not describe the ordinary read or scoped accept-edits allowances.
   */
  readonly automaticApprovals: boolean;
  /** No configuration guarantees a universal prompt bypass; boundaries still apply. */
  readonly bypassesPrompts: false;
  /** A short, honest, human-facing label, always names auto-approve explicitly when it is what is actually gating tool calls. */
  readonly label: string;
  /** An explanation of the preset and boundary, suitable for a doctor/status detail line. */
  readonly detail: string;
}

function normalizeMode(mode: unknown): 'prompt' | 'allow-all' | 'custom' | 'plan' | 'accept-edits' {
  if (mode === 'allow-all' || mode === 'custom' || mode === 'plan' || mode === 'accept-edits') return mode;
  return 'prompt';
}

/**
 * Pure precedence computation, no config access. Every display surface
 * should route its "what is the approval posture" question through this
 * function so they provably agree with each other and with the gate.
 */
export function computeApprovalPosture(input: ApprovalPostureInput): ApprovalPosture {
  const mode = normalizeMode(input.mode);
  const preset = presetForMode(mode);
  const boundaryCaveat = 'Boundary checks still apply and can refuse a call or require approval.';

  if (input.autoApprove) {
    return {
      kind: 'auto-approve',
      mode,
      autoApprove: true,
      automaticApprovals: true,
      bypassesPrompts: false,
      label: 'Auto-approve ON, boundary checks still apply',
      detail: `behavior.autoApprove is enabled: calls that pass the boundary are approved automatically, regardless of permissions.mode or custom per-tool rules. ${boundaryCaveat}`,
    };
  }

  if (mode === 'allow-all') {
    return {
      kind: 'allow-all',
      mode,
      autoApprove: false,
      automaticApprovals: true,
      bypassesPrompts: false,
      label: 'Automatic below critical stakes',
      detail: `permissions.mode is allow-all (${preset.name}): ${preset.summary} ${boundaryCaveat}`,
    };
  }

  if (mode === 'plan') {
    return {
      kind: 'plan',
      mode,
      autoApprove: false,
      bypassesPrompts: false,
      automaticApprovals: false,
      label: 'Plan mode, read-only',
      detail: `permissions.mode is plan: ${preset.summary} ${boundaryCaveat}`,
    };
  }

  if (mode === 'accept-edits') {
    return {
      kind: 'accept-edits',
      mode,
      autoApprove: false,
      bypassesPrompts: false,
      automaticApprovals: false,
      label: 'Accept edits, other actions follow stakes',
      detail: `permissions.mode is accept-edits: ${preset.summary} ${boundaryCaveat}`,
    };
  }

  if (mode === 'custom') {
    const values = Object.values(input.customTools ?? {});
    const allAllow = values.length > 0 && values.every((value) => value === 'allow');
    return {
      kind: 'custom',
      mode,
      autoApprove: false,
      automaticApprovals: allAllow,
      bypassesPrompts: false,
      label: allAllow ? 'Custom rules (all configured categories allow)' : 'Custom rules',
      detail: allAllow
        ? `permissions.mode is custom and every configured tool category is set to allow. ${preset.summary} ${boundaryCaveat}`
        : `permissions.mode is custom: ${preset.summary} ${boundaryCaveat}`,
    };
  }

  return {
    kind: 'prompt',
    mode: 'prompt',
    autoApprove: false,
    automaticApprovals: false,
    bypassesPrompts: false,
    label: 'Ask before powerful actions',
    detail: `permissions.mode is prompt (${preset.name}): ${preset.summary} ${boundaryCaveat}`,
  };
}

/**
 * Convenience for callers holding a real ConfigManager (or any subset
 * exposing `get` + `getCategory`): reads behavior.autoApprove and
 * permissions.mode/tools the same way the gate does and computes the posture.
 */
export function readApprovalPostureFromConfig(
  configManager: Pick<ConfigManager, 'get' | 'getCategory'>,
): ApprovalPosture {
  const autoApprove = isAutoApproveEnabled(configManager);
  const permissions = configManager.getCategory('permissions');
  return computeApprovalPosture({
    autoApprove,
    mode: permissions.mode,
    customTools: { ...permissions.tools },
  });
}
