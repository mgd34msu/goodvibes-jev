/**
 * Types of the gate's per-call decision (the gate replaces the old permission
 * layer; the type names keep their permission prefix so every surface that
 * renders a decision keeps compiling).
 */
import type { BoundaryCheck, BoundaryCheckName } from '../gate/boundary.js';
import type { GateRiskFamily } from '../gate/batteries/risk-family.js';
import type { GateFactName } from '../gate/reading.js';
import type { GatePresetName, GateAction } from '../gate/presets.js';

export type PermissionCategory = 'read' | 'write' | 'execute' | 'delegate';

export type PermissionRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type PermissionDecisionSource =
  // The gate's boundary refused the call
  | 'boundary'
  // The active preset decided on Jev's stakes reading
  | 'stakes_preset'
  | 'config_policy'
  | 'managed_policy'
  | 'safety_check'
  | 'runtime_mode'
  | 'session_override'
  // A durable user-origin rule written by a remembered approval decision
  | 'user_rule'
  | 'user_prompt';

export type PermissionDecisionReasonCode =
  // Boundary refusals, one per check
  | 'boundary_judgment_input'
  | 'boundary_catastrophic'
  | 'boundary_surface_authority'
  | 'boundary_card_details'
  | 'boundary_outward_effect'
  // The active preset allowed or denied the call on its stakes
  | 'preset_allow'
  | 'preset_deny'
  // The owner answered the prompt for a tainted outward call (single use)
  | 'owner_approved_outward'
  | 'config_allow'
  | 'config_deny'
  | 'managed_policy_allow'
  | 'managed_policy_deny'
  | 'safety_guardrail'
  | 'mode_allow_all'
  | 'mode_denied'
  // Mode, plan mode refused a mutating/exec tool (structured plan-mode denial)
  | 'plan_mode'
  // Mode, accept-edits mode auto-approved a file write/edit tool
  | 'mode_accept_edits'
  | 'session_cached_allow'
  | 'session_cached_deny'
  // Durable user rule matched (allow/deny), the persistent form of a remembered decision
  | 'user_rule_allow'
  | 'user_rule_deny'
  | 'user_approved'
  | 'user_denied';

export type PermissionAnalysisTargetKind = 'command' | 'path' | 'url' | 'task' | 'generic';
export type PermissionAnalysisSurface = 'filesystem' | 'shell' | 'network' | 'orchestration' | 'platform' | 'generic';
export type PermissionBlastRadius = 'local' | 'project' | 'external' | 'delegated' | 'platform';

export interface PermissionRequestAnalysis {
  readonly classification: string;
  readonly riskLevel: PermissionRiskLevel;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly target?: string | undefined;
  readonly targetKind?: PermissionAnalysisTargetKind | undefined;
  readonly surface?: PermissionAnalysisSurface | undefined;
  readonly blastRadius?: PermissionBlastRadius | undefined;
  readonly sideEffects?: readonly string[] | undefined;
  readonly host?: string | undefined;
  /** The risk family Jev read, when the gate read the call. */
  readonly riskFamily?: GateRiskFamily | undefined;
}

/** What the gate's reading of a call concluded, as a decision carries it. */
export interface GateReadingRecord {
  readonly family: GateRiskFamily;
  readonly stakes: PermissionRiskLevel;
  readonly facts: Readonly<Record<GateFactName, boolean>>;
  readonly uncertain: readonly GateFactName[];
}

/** The boundary's outcome, as a decision carries it. */
export interface GateBoundaryRecord {
  readonly passed: boolean;
  readonly refusedBy?: BoundaryCheckName | undefined;
  readonly checks: readonly BoundaryCheck[];
}

/** The preset's decision, as a decision carries it. */
export interface GatePresetRecord {
  readonly preset: GatePresetName;
  readonly action: GateAction;
}

export interface PermissionCheckResult {
  readonly approved: boolean;
  readonly persisted: boolean;
  readonly sourceLayer: PermissionDecisionSource;
  readonly reasonCode: PermissionDecisionReasonCode;
  readonly analysis: PermissionRequestAnalysis;
  /**
   * When present, replaces the tool call's original arguments for execution
   * (e.g. a per-hunk-filtered `edits` array for the `edit` tool). Only ever
   * populated via the user-prompt approval path (`sourceLayer: 'user_prompt'`).
   */
  readonly modifiedArgs?: Record<string, unknown> | undefined;
  /**
   * The user's free-text note from the prompt decision (most useful on a
   * denial, it rides the structured "user declined" tool result so the model
   * can adapt). Only ever populated via the user-prompt approval path.
   */
  readonly userReason?: string | undefined;
  /** The boundary's checks; absent only for a call no check applied to. */
  readonly boundary?: GateBoundaryRecord | undefined;
  /** Jev's reading, when the gate read the call. */
  readonly reading?: GateReadingRecord | undefined;
  /** The preset's decision, when the reading reached a preset. */
  readonly preset?: GatePresetRecord | undefined;
  /** Why the gate refused, in words the asking agent can act on. */
  readonly detail?: string | undefined;
  /**
   * The category the gate settled on: a built-in tool's own category, or, for
   * any other tool, the one Jev read from what the call does.
   */
  readonly category?: PermissionCategory | undefined;
}
