/**
 * The gate: the one path every side effect takes. Jev reads the call
 * (reading.ts), the boundary refuses what no preset may allow (boundary.ts),
 * then graduated autonomy: the active preset (presets.ts) allows, asks or
 * denies on the reading's stakes. The
 * decision pipeline itself runs in permissions/manager.ts (PermissionManager).
 */
export * from './boundary.js';
export * from './presets.js';
export * from './reading.js';
export * from './surface-authority.js';
export { riskFamily, RISK_FAMILY_OPTIONS, type GateRiskFamily } from './batteries/risk-family.js';
export { sideEffect, SIDE_EFFECT_KIND_OPTIONS, MCP_CAPABILITY_OPTIONS, type SideEffectKind } from './batteries/side-effect.js';
export { sandboxAdvisory } from './batteries/sandbox-advisory.js';
export { executionVerification } from './batteries/execution-verification.js';
export { registry as gateJudgmentRegistry } from './judgment-registry.js';

/** Full-size validated snapshots for asynchronous callers; never a projected reading. */
export { snapshotJudgmentInput, captureOwnedJson, retainOwnedJson, assertJudgmentInput, judgmentInputCardProblem } from './judgment-input.js';
export type { RetainedOwnedJson } from './judgment-input.js';
export { captureJudgmentFailure } from './failure-input.js';
export { decideAutonomous } from './autonomous-decision.js';
export type { AutonomousDecisionInput, AutonomousDecision, AutonomousContinuation, AutonomousCondition } from './autonomous-decision.js';
export { admitJudgmentJson, captureStrictJudgmentJson, retainStrictJudgmentJson, prepareJudgmentResult, JudgmentResultAdmissionError } from './judgment-result.js';
export type { JudgmentResultAdmissionFailure, JudgmentResultAdmissionProblem, RetainedStrictJudgmentJson } from './judgment-result.js';
