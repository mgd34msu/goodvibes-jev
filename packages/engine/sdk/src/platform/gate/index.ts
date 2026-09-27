/**
 * The gate: the one path every side effect takes. A deterministic boundary
 * first (boundary.ts), then graduated autonomy: Jev reads each call's stakes
 * (reading.ts) and the active preset (presets.ts) allows, asks or denies. The
 * decision pipeline itself runs in permissions/manager.ts (PermissionManager).
 */
export * from './boundary.js';
export * from './presets.js';
export * from './reading.js';
export * from './surface-authority.js';
export { riskFamily, RISK_FAMILY_OPTIONS, type GateRiskFamily } from './batteries/risk-family.js';
export { sideEffect, SIDE_EFFECT_KIND_OPTIONS, MCP_CAPABILITY_OPTIONS, type SideEffectKind } from './batteries/side-effect.js';
export { sandboxAdvisory } from './batteries/sandbox-advisory.js';
export { registry as gateJudgmentRegistry } from './judgment-registry.js';
