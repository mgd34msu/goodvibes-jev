import type { AgentWorkspaceAction, AgentWorkspaceCategory } from './agent-workspace-types.ts';

// These are WIZARD-STEP ids (AgentSetupWizardStep.id), NOT normalized plan ids.
// Do NOT cross-check these against SetupPlanItem ids or PLAN_ITEM_CATEGORY_MAP keys.
// (Compare: agent-workspace-onboarding-state.ts normalises 'provider-model' → 'provider-access' for plan-layer lookups.)
export const ONBOARDING_CRITICAL_STEP_IDS = ['runtime', 'connected-host-auth', 'provider-model'] as const;

export const ONBOARDING_COMPLETE_SYNTHETIC_ACTION: AgentWorkspaceAction = {
  id: 'onboarding-apply-close',
  label: 'Apply & close',
  detail: 'Acknowledge onboarding as finished, persist the user completion marker, and close the fullscreen Agent workspace.',
  kind: 'onboarding-complete',
  safety: 'safe',
};

export function shouldShowOnboardingFinishFooter(
  category: AgentWorkspaceCategory,
  baseActions: readonly AgentWorkspaceAction[],
  readyToChat?: boolean,
): boolean {
  if (category.group !== 'ONBOARDING') return false;
  if (baseActions.some((a) => a.kind === 'onboarding-complete')) return false;
  // When readyToChat is explicitly false (we have a valid OnboardingState and the user
  // cannot chat yet), withhold the footer so completion is not premature.
  // When readyToChat is undefined (no OnboardingState available), default to showing.
  if (readyToChat === false) return false;
  return true;
}
