import { isAutoApproveEnabled } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';

/** Configuration descriptions shared by status, doctor, policy explanation and the footer.
 * Ordinary permitted calls proceed automatically; configured denials, read-only
 * modes, surface authority and invocation lifetime still constrain execution.
 */

export type ApprovalPostureKind = 'auto-approve' | 'allow-all' | 'custom' | 'prompt' | 'plan' | 'accept-edits';

export interface ApprovalPostureInput {
  /** behavior.autoApprove, read via the SDK's isAutoApproveEnabled (or an equivalent duck-typed read). */
  readonly autoApprove: boolean;
  /** permissions.mode, as read from config (may be unknown/malformed input from a loose config source). */
  readonly mode: unknown;
  /**
   * permissions.tools, only consulted when mode === 'custom'. Values are the
   * per-tool-category actions ('allow' | 'prompt' | 'deny'); explicit denials constrain the automatic posture.
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
   * Configured actions proceed automatically without a read-only mode or custom denial.
   * Describes the configured posture, not authority for an individual call.
   */
  readonly automaticApprovals: boolean;
  /** Compatibility flag: configuration alone never grants universal invocation authority. */
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
  const configuredDenial = mode === 'custom' && Object.values(input.customTools ?? {}).some(value => value === 'deny');
  const labels = {
    prompt: 'Automatic configured actions',
    'allow-all': 'Allow all configured actions',
    custom: 'Custom rules',
    plan: 'Plan mode, read-only',
    'accept-edits': 'Accept edits, automatic configured actions',
  };
  return {
    kind: input.autoApprove ? 'auto-approve' : mode,
    mode, autoApprove: input.autoApprove,
    automaticApprovals: mode !== 'plan' && !configuredDenial,
    bypassesPrompts: false,
    label: `${input.autoApprove ? 'Auto-approve ON, ' : ''}${labels[mode]}`,
    detail: `permissions.mode is ${mode}: ${labels[mode]}. Configured denials, read-only modes and surface authority still apply. Calls require current invocation authority.`,
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
