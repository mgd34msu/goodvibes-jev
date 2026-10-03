import type { SetupPlanItem, SetupPlanStatus } from '../../tools/agent-harness-setup-posture-types.ts';
import type { OnboardingCheckMarkerState } from './types.ts';

/**
 * Maps each setup plan item id to the Agent Workspace category that resolves it.
 * This is the single sequencing table, every onboarding surface reads from here.
 */
const PLAN_ITEM_CATEGORY_MAP: Readonly<Record<string, string>> = {
  'connected-host-readiness': 'setup',
  'connected-host-auth': 'setup',
  'goodvibes-settings-import': 'setup',
  'provider-access': 'account-model',
  'install-smoke': 'setup',
  'local-model-readiness': 'account-model',
  'agent-knowledge': 'setup',
  'vibe-personality': 'assistant-behavior',
  'local-behavior': 'onboarding-context',
  'communication-channels': 'onboarding-channels',
  'automation-review': 'tools-permissions',
  'browser-desktop-control': 'tools-permissions',
  'sudo-execution-posture': 'tools-permissions',
  'build-delegation': 'tools-permissions',
  'finish-onboarding': 'setup',
};

const DEFAULT_CATEGORY_ID = 'setup';

function planItemCategoryId(planItemId: string): string {
  return PLAN_ITEM_CATEGORY_MAP[planItemId] ?? DEFAULT_CATEGORY_ID;
}

export interface OnboardingStep {
  readonly id: string;
  readonly label: string;
  readonly status: SetupPlanStatus;
  readonly blocksAutonomy: boolean;
  /** Human-readable hint shown in the UI for the next action. */
  readonly nextLabel: string;
  /** Agent Workspace category id that resolves this step. */
  readonly categoryId: string;
}

export interface OnboardingRecap {
  /** Single headline sentence describing overall readiness. */
  readonly headline: string;
  /** One line per ready capability plus optional trailing lines. */
  readonly lines: readonly string[];
}

export type OnboardingPhase = 'fresh' | 'in-progress' | 'complete';

export interface OnboardingState {
  /**
   * Phase derived from markers:
   * - 'complete'     completion marker present
   * - 'in-progress'  check marker present but no completion marker
   * - 'fresh'        neither marker present
   */
  readonly phase: OnboardingPhase;
  /** All setup plan items converted to lightweight steps. */
  readonly steps: readonly OnboardingStep[];
  /** First non-ready step that blocks autonomy, or first non-ready step if none, or null. */
  readonly currentStepId: string | null;
  /** Human-readable progress, e.g. "2 of 5 ready". */
  readonly progressLabel: string;
  /** Steps that are not ready and block autonomy. */
  readonly blockers: readonly OnboardingStep[];
  /**
   * True when a usable model route exists:
   * the provider-access plan item is 'ready', or local-model-readiness is 'ready'.
   */
  readonly readyToChat: boolean;
  /** Summary shown at the end of onboarding or as a re-entry summary. */
  readonly recap: OnboardingRecap;
}

export interface DeriveOnboardingStateContext {
  /** Fully-built setup plan (from buildSetupPlan). */
  readonly plan: readonly SetupPlanItem[];
  /** User-scope check marker (from readOnboardingCheckMarker). */
  readonly checkMarker: OnboardingCheckMarkerState;
  /** User-scope completion marker (from readOnboardingCompletionMarker). */
  readonly completionMarker: OnboardingCheckMarkerState;
}

function derivePhase(
  checkMarker: OnboardingCheckMarkerState,
  completionMarker: OnboardingCheckMarkerState,
): OnboardingPhase {
  if (completionMarker.exists && completionMarker.payload !== null) return 'complete';
  if (checkMarker.exists) return 'in-progress';
  return 'fresh';
}

function planItemToStep(item: SetupPlanItem): OnboardingStep {
  return {
    id: item.id,
    label: item.label,
    status: item.status,
    blocksAutonomy: item.blocksAutonomy,
    nextLabel: item.nextAction,
    categoryId: planItemCategoryId(item.id),
  };
}

function deriveCurrentStepId(steps: readonly OnboardingStep[]): string | null {
  // Priority: first non-ready blocker, then first non-ready step overall.
  const firstBlocker = steps.find((s) => s.status !== 'ready' && s.blocksAutonomy);
  if (firstBlocker) return firstBlocker.id;
  const firstNonReady = steps.find((s) => s.status !== 'ready');
  return firstNonReady?.id ?? null;
}

function deriveProgressLabel(plan: readonly SetupPlanItem[]): string {
  const ready = plan.filter((item) => item.status === 'ready').length;
  const total = plan.length;
  return `${ready} of ${total} ready`;
}

function deriveReadyToChat(plan: readonly SetupPlanItem[]): boolean {
  const providerItem = plan.find((item) => item.id === 'provider-access');
  if (providerItem?.status === 'ready') return true;
  const localModelItem = plan.find((item) => item.id === 'local-model-readiness');
  return localModelItem?.status === 'ready';
}

function deriveRecap(
  phase: OnboardingPhase,
  steps: readonly OnboardingStep[],
  plan: readonly SetupPlanItem[],
): OnboardingRecap {
  const readySteps = steps.filter((s) => s.status === 'ready');
  const optionalCount = plan.filter(
    (item) => item.status !== 'ready' && !item.blocksAutonomy,
  ).length;

  const headline =
    phase === 'complete'
      ? "You're set up. Here's what you can do now."
      : phase === 'in-progress'
        ? "Setup is in progress. Here's what's ready so far."
        : 'Getting started, a few things to set up before the full experience.';

  const lines: string[] = readySteps.map((s) => s.label);

  // Capability examples: show what the user can actually do right now.
  // Always-safe examples (research/draft/summarize) are shown whenever a model route is ready.
  // Channel-dependent examples (reminders/messaging) only appear when that lane is configured.
  const modelReady = deriveReadyToChat(plan);
  if (modelReady && phase !== 'fresh') {
    const channelsReady = plan.some(
      (item) => item.id === 'communication-channels' && item.status === 'ready',
    );
    const capabilityLines: string[] = [
      'Ask me to research a topic, draft an email, summarize a file, or compare models.',
    ];
    if (channelsReady) {
      capabilityLines.push('You can also set reminders and send messages through your connected channels.');
    }
    lines.push(...capabilityLines);
  }

  if (optionalCount > 0 && phase !== 'fresh') {
    lines.push(`Still optional: ${optionalCount} item${optionalCount === 1 ? '' : 's'} available`);
  }

  if (phase !== 'fresh') {
    lines.push('Try: "What can you help me with today?"');
  }

  return { headline, lines };
}

/**
 * Pure selector: derives the full OnboardingState from an already-built plan and
 * the current marker files. No side effects, no Date.now() calls.
 */
export function deriveOnboardingState(
  context: DeriveOnboardingStateContext,
): OnboardingState {
  const { plan, checkMarker, completionMarker } = context;

  const phase = derivePhase(checkMarker, completionMarker);
  const steps = plan.map(planItemToStep);
  const currentStepId = deriveCurrentStepId(steps);
  const progressLabel = deriveProgressLabel(plan);
  const blockers = steps.filter((s) => s.status !== 'ready' && s.blocksAutonomy);
  const readyToChat = deriveReadyToChat(plan);
  const recap = deriveRecap(phase, steps, plan);

  return {
    phase,
    steps,
    currentStepId,
    progressLabel,
    blockers,
    readyToChat,
    recap,
  };
}
