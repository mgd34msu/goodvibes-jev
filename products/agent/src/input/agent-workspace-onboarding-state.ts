import type { AgentSetupWizardStep } from '../agent/setup-wizard.ts';
import type { SetupPlanItem } from '../tools/agent-harness-setup-posture-types.ts';
import type { AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';
import type { OnboardingShellPaths } from '../runtime/onboarding/types.ts';
import {
  deriveOnboardingState,
  readOnboardingCheckMarker,
  readOnboardingCompletionMarker,
  type OnboardingState,
} from '../runtime/onboarding/index.ts';

/**
 * Adapts an AgentSetupWizardStep to a SetupPlanItem for use with
 * deriveOnboardingState. The wizard uses different IDs for some steps;
 * this adapter normalises the two known divergences:
 *   - 'provider-model' (wizard) → 'provider-access' (plan) so readyToChat
 *     and PLAN_ITEM_CATEGORY_MAP both resolve correctly.
 * The output ids are PLAN ids (SetupPlanItem.id), not wizard-step ids.
 * Do NOT compare the output ids against ONBOARDING_CRITICAL_STEP_IDS which
 * operates on wizard-step ids (see agent-workspace-onboarding-finish.ts).
 * blocksAutonomy is inferred from sourceStatus: blocked or check items block autonomy.
 * Intentional approximation: AgentSetupWizardStep does not carry the authoritative
 * SetupPlanItem.blocksAutonomy field; the wizard snapshot only exposes sourceStatus,
 * so we derive it from status here rather than threading the real value through.
 */
function wizardItemToSetupPlanItem(step: AgentSetupWizardStep): SetupPlanItem {
  const id = step.id === 'provider-model' ? 'provider-access' : step.id;
  return {
    id,
    label: step.label,
    status: step.sourceStatus,
    priority: 0,
    // Intentional approximation: AgentSetupWizardStep doesn't carry blocksAutonomy;
    // derive it from sourceStatus since the real value isn't available at this layer.
    blocksAutonomy: step.sourceStatus === 'blocked' || step.sourceStatus === 'check',
    reason: step.detail,
    nextAction: step.userRoute,
    userRoute: step.userRoute,
    modelRoute: step.modelRoute,
  };
}

export interface OnboardingEntryResult {
  /** Category ID to navigate to on entry (undefined = leave as-is). */
  readonly categoryId: string | undefined;
  /** Status message to display. */
  readonly status: string;
}

/**
 * Derives the entry navigation and status message from an OnboardingState.
 * Called by open() in ONBOARDING mode.
 */
export function deriveOnboardingEntry(obs: OnboardingState): OnboardingEntryResult {
  if (obs.phase === 'in-progress' && obs.currentStepId) {
    const step = obs.steps.find((s) => s.id === obs.currentStepId);
    if (step) return { categoryId: step.categoryId, status: `Picking up where you left off: ${step.label}.` };
  }
  const currentStep = obs.steps.find((s) => s.id === obs.currentStepId);
  const nextHint = currentStep ? `, ${currentStep.nextLabel}` : '';
  return { categoryId: undefined, status: `${obs.progressLabel}${nextHint}.` };
}

/**
 * Given an OnboardingState, computes the set of ONBOARDING category IDs that are
 * currently unlocked and adds them to the provided mutable revealed set.
 * 'setup' is always present; other categories unlock once their step is ready.
 */
export function updateRevealedOnboardingCategories(
  obs: OnboardingState,
  revealed: Set<string>,
): void {
  revealed.add('setup');
  for (const step of obs.steps) {
    if (step.status === 'ready') revealed.add(step.categoryId);
  }
  if (obs.readyToChat) revealed.add('account-model');
  // Also reveal the active resume target so that navigating to it on re-entry
  // actually works. The resume target is by definition non-ready (it is the
  // first blocker), so it would otherwise be filtered out above. Only adds,
  // preserves monotonicity of the revealed set.
  if (obs.phase === 'in-progress' && obs.currentStepId) {
    const cur = obs.steps.find((s) => s.id === obs.currentStepId);
    if (cur) revealed.add(cur.categoryId);
  }
}

/**
 * Derives the current OnboardingState from a runtime snapshot and shell paths.
 * Returns null when no snapshot is available (e.g. context is not fully initialised).
 * Reads check and completion markers from shellPaths when provided.
 */
export function computeOnboardingStateFromSnapshot(
  snapshot: AgentWorkspaceRuntimeSnapshot | null,
  shellPaths: OnboardingShellPaths | undefined,
): OnboardingState | null {
  const wizard = snapshot?.setupWizard;
  if (!wizard?.steps?.length) return null;

  const plan: SetupPlanItem[] = wizard.steps.map(wizardItemToSetupPlanItem);

  // Build minimal marker states, default to non-existent when shellPaths is unavailable.
  const checkMarker = shellPaths
    ? readOnboardingCheckMarker(shellPaths, 'user')
    : { scope: 'user' as const, path: '', exists: false, payload: null };
  const completionMarker = shellPaths
    ? readOnboardingCompletionMarker(shellPaths, 'user')
    : { scope: 'user' as const, path: '', exists: false, payload: null };

  return deriveOnboardingState({ plan, checkMarker, completionMarker });
}
