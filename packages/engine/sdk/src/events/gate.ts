/**
 * GateEvent, the discriminated union of the gate's events: the one path every
 * side effect takes (platform/gate). A call is requested, passes the
 * deterministic boundary, is read by Jev for its stakes, and the active
 * preset (or an explicit owner rule, or the owner's answer) decides it.
 */

/** One boundary check's outcome, as BOUNDARY_CHECKED carries it. */
export interface GateBoundaryCheckRecord {
  readonly check: string;
  readonly result: 'pass' | 'refuse' | 'skipped';
}

export type GateEvent =
  /** A tool call has reached the gate. */
  | {
      type: 'GATE_REQUESTED';
      callId: string;
      tool: string;
      args: Record<string, unknown>;
      category: string;
      classification?: string | undefined;
      riskLevel?: string | undefined;
      summary?: string | undefined;
      reasons?: readonly string[] | undefined;
    }
  /** Policy rules have been collected from all sources. */
  | { type: 'RULES_COLLECTED'; callId: string; tool: string; ruleCount: number }
  /** Tool arguments have been normalised for policy evaluation. */
  | { type: 'INPUT_NORMALIZED'; callId: string; tool: string }
  /** User and managed policy rules have been evaluated. */
  | { type: 'POLICY_EVALUATED'; callId: string; tool: string; result: 'allow' | 'deny' | 'unknown' }
  /** Remembered approvals (session and durable) have been evaluated. */
  | { type: 'SESSION_OVERRIDE_EVALUATED'; callId: string; tool: string; overrideApplied: boolean }
  /**
   * The deterministic boundary ran: catastrophic commands, surface authority,
   * card shapes and the outward-effect check. `refusedBy` names the check
   * that refused the call, when one did.
   */
  | {
      type: 'BOUNDARY_CHECKED';
      callId: string;
      tool: string;
      passed: boolean;
      refusedBy?: string | undefined;
      checks: readonly GateBoundaryCheckRecord[];
    }
  /** Jev read the call: its risk family, the facts behind its stakes, and the stakes code composed. */
  | {
      type: 'STAKES_READ';
      callId: string;
      tool: string;
      family: string;
      stakes: 'low' | 'medium' | 'high' | 'critical';
      mutates: boolean;
      outward: boolean;
      secrets: boolean;
      irreversible: boolean;
      beyondProject: boolean;
      weakensSecurity: boolean;
      obfuscated: boolean;
      /** Facts whose reading was uncertain and were therefore taken as true. */
      uncertain: readonly string[];
    }
  /** The active preset mapped the call's stakes to an action. */
  | {
      type: 'PRESET_EVALUATED';
      callId: string;
      tool: string;
      preset: string;
      stakes: 'low' | 'medium' | 'high' | 'critical';
      result: 'allow' | 'ask' | 'deny';
    }
  /**
   * The active preset changed (normal, accept-edits, plan, auto, custom).
   * Emitted whenever the `permissions.mode` setting changes so surfaces can
   * render a live preset pill without polling. `mode` and `previousMode` are
   * the setting's values ('prompt' | 'allow-all' | 'custom' | 'plan' |
   * 'accept-edits'); `preset` and `previousPreset` are the preset names.
   */
  | { type: 'PRESET_CHANGED'; preset: string; previousPreset: string; mode: string; previousMode: string }
  /** The gate's final decision for the call. */
  | {
      type: 'DECISION_EMITTED';
      callId: string;
      tool: string;
      approved: boolean;
      source: string;
      sourceLayer?: string | undefined;
      persisted?: boolean | undefined;
      reasonCode?: string | undefined;
      classification?: string | undefined;
      riskLevel?: string | undefined;
      summary?: string | undefined;
    };

/** All gate event type literals as a union. */
export type GateEventType = GateEvent['type'];

/** Every gate event type, for validators and consumers that enumerate the domain. */
export const GATE_EVENT_TYPES: readonly GateEventType[] = [
  'GATE_REQUESTED',
  'RULES_COLLECTED',
  'INPUT_NORMALIZED',
  'POLICY_EVALUATED',
  'SESSION_OVERRIDE_EVALUATED',
  'BOUNDARY_CHECKED',
  'STAKES_READ',
  'PRESET_EVALUATED',
  'PRESET_CHANGED',
  'DECISION_EMITTED',
];
