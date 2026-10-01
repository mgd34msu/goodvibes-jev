import { isAutoApproveEnabled } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';

/**
 * ApprovalPosture, the single source of truth for "what will happen when a
 * tool runs right now", displayed identically everywhere the Agent surfaces
 * approval posture (cli status, cli doctor, the security policy-explain tool,
 * and the footer's danger indicator).
 *
 * Mirrors PermissionManager.checkDetailed()'s exact precedence (SDK
 * dist/platform/permissions/manager.js:103-138), which this module does not
 * modify, the gate is correct; the historical bug was surfaces disagreeing
 * about what the gate does:
 *   1. behavior.autoApprove === true -> every tool call is approved
 *      automatically, before permissions.mode is even read.
 *   2. permissions.mode === 'allow-all' -> every tool call is approved
 *      automatically.
 *   2a. permissions.mode === 'plan' -> read-only tools are allowed; every
 *       write, execute, or delegate tool call is REFUSED outright (not
 *       asked) with a structured plan-mode denial, steering the model to
 *       present a plan instead of acting.
 *   2b. permissions.mode === 'accept-edits' -> read and file write/edit
 *       tool calls are approved automatically; execute and every other
 *       risky class still fall through to the prompt/cache path below.
 *   3. permissions.mode === 'custom' -> each tool category is allowed,
 *      prompted, or denied per its own configured rule; bypassesPrompts is
 *      true only when EVERY configured tool category resolves to 'allow'
 *      (the only custom configuration where nothing ever prompts).
 *   4. permissions.mode === 'prompt' (the default) -> read-only actions are
 *      auto-allowed; write, execute, and delegate actions prompt.
 *
 * Any surface that wants to say "will this prompt me?" must call
 * computeApprovalPosture (or the config-reading convenience below) rather
 * than re-deriving the precedence locally, that re-derivation is exactly
 * how cli/status.ts drifted from the gate (it read permissions.mode alone
 * and never looked at behavior.autoApprove). It is also how 'plan' and
 * 'accept-edits' modes previously drifted: normalizeMode used to fold any
 * mode it did not recognize into 'prompt', so a surface reading the posture
 * label for those two modes silently mislabeled them as "Ask before
 * powerful actions", wrong for plan mode (which never asks; it refuses)
 * and wrong for accept-edits mode (which auto-approves file writes without
 * asking).
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
   * (missing/unrecognized) counts as NOT allow for the bypass computation.
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
   * True when NO tool call will ever hit a Human-in-the-Loop prompt under the
   * current configuration, mirrors the gate's "auto-approve everything"
   * branches (autoApprove, allow-all, and custom-all-allow).
   */
  readonly bypassesPrompts: boolean;
  /** A short, honest, human-facing label, always names auto-approve explicitly when it is what is actually gating tool calls. */
  readonly label: string;
  /** A one-sentence explanation of the mechanism, suitable for a doctor/status detail line. */
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

  if (input.autoApprove) {
    return {
      kind: 'auto-approve',
      mode,
      autoApprove: true,
      bypassesPrompts: true,
      label: 'Auto-approve ON, powerful actions run without asking',
      detail: 'behavior.autoApprove is enabled: every tool call is approved automatically, regardless of permissions.mode or any custom per-tool rule.',
    };
  }

  if (mode === 'allow-all') {
    return {
      kind: 'allow-all',
      mode,
      autoApprove: false,
      bypassesPrompts: true,
      label: 'Allow everything',
      detail: 'permissions.mode is allow-all: every tool call is approved automatically.',
    };
  }

  if (mode === 'plan') {
    return {
      kind: 'plan',
      mode,
      autoApprove: false,
      bypassesPrompts: false,
      label: 'Plan mode, read-only, nothing prompts because nothing mutates',
      detail: 'permissions.mode is plan: read-only tool calls are approved automatically; every write, execute, or delegate tool call is refused outright (never asked) so the model presents a plan instead of acting.',
    };
  }

  if (mode === 'accept-edits') {
    return {
      kind: 'accept-edits',
      mode,
      autoApprove: false,
      bypassesPrompts: false,
      label: 'Accept edits, file writes auto-approve, execute/delegate still ask',
      detail: 'permissions.mode is accept-edits: read and file write/edit tool calls are approved automatically without asking; execute and every other risky class still prompt for approval.',
    };
  }

  if (mode === 'custom') {
    const values = Object.values(input.customTools ?? {});
    const allAllow = values.length > 0 && values.every((value) => value === 'allow');
    return {
      kind: 'custom',
      mode,
      autoApprove: false,
      bypassesPrompts: allAllow,
      label: allAllow ? 'Custom rules (every category allows, no prompts)' : 'Custom rules',
      detail: allAllow
        ? 'permissions.mode is custom and every configured tool category is set to allow: no tool call prompts.'
        : 'permissions.mode is custom: each tool category is allowed, prompted, or denied per its own configured rule.',
    };
  }

  return {
    kind: 'prompt',
    mode: 'prompt',
    autoApprove: false,
    bypassesPrompts: false,
    label: 'Ask before powerful actions',
    detail: 'permissions.mode is prompt (default): read-only actions are auto-allowed; write, execute, and delegate actions prompt for approval.',
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
