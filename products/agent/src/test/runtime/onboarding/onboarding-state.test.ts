import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import {
  readOnboardingCheckMarker,
  readOnboardingCompletionMarker,
  writeOnboardingCheckMarker,
  writeOnboardingCompletionMarker,
} from '../../../runtime/onboarding/index.ts';
import {
  deriveOnboardingState,
  type DeriveOnboardingStateContext,
  type OnboardingPhase,
} from '../../../runtime/onboarding/onboarding-state.ts';
import type { SetupPlanItem, SetupPlanStatus } from '../../../tools/agent-harness-setup-posture-types.ts';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createShellPaths() {
  const root = makeProjectTempDir(`gv-onboarding-state-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return createShellPathService({
    workingDirectory: join(root, 'workspace'),
    homeDirectory: join(root, 'home'),
  });
}

function makePlanItem(id: string, status: SetupPlanStatus, blocksAutonomy: boolean, overrides: Partial<SetupPlanItem> = {}): SetupPlanItem {
  return {
    id,
    label: `Label for ${id}`,
    status,
    priority: 10,
    blocksAutonomy,
    reason: `Reason for ${id}`,
    nextAction: `Fix ${id}`,
    userRoute: `UI -> ${id}`,
    modelRoute: `agent ${id}`,
    ...overrides,
  };
}

/**
 * Minimal plan covering the key plan item ids used in categoryId mapping tests.
 */
function makeFullPlan(): readonly SetupPlanItem[] {
  return [
    makePlanItem('connected-host-readiness', 'blocked', true),
    makePlanItem('connected-host-auth', 'blocked', true),
    makePlanItem('goodvibes-settings-import', 'optional', false),
    makePlanItem('provider-access', 'blocked', true),
    makePlanItem('install-smoke', 'blocked', false),
    makePlanItem('local-model-readiness', 'recommended', false),
    makePlanItem('agent-knowledge', 'recommended', false),
    makePlanItem('vibe-personality', 'recommended', false),
    makePlanItem('local-behavior', 'optional', false),
    makePlanItem('communication-channels', 'optional', false),
    makePlanItem('automation-review', 'optional', false),
    makePlanItem('browser-desktop-control', 'optional', false),
    makePlanItem('sudo-execution-posture', 'optional', false),
    makePlanItem('build-delegation', 'optional', false),
    makePlanItem('finish-onboarding', 'recommended', false),
  ];
}

/**
 * Plan where all items are ready (simulates complete setup).
 */
function makeAllReadyPlan(): readonly SetupPlanItem[] {
  return makeFullPlan().map((item) => ({ ...item, status: 'ready' as const }));
}

// ---------------------------------------------------------------------------
// Phase transition tests
// ---------------------------------------------------------------------------

describe('deriveOnboardingState: phase transitions', () => {
  test('fresh: no markers present', () => {
    const shellPaths = createShellPaths();
    const context: DeriveOnboardingStateContext = {
      plan: makeFullPlan(),
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    };

    const state = deriveOnboardingState(context);

    expect(state.phase).toBe<OnboardingPhase>('fresh');
  });

  test('in-progress: check marker present, no completion marker', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, {
      scope: 'user',
      checkedAt: 1000,
      updatedAt: 1000,
      source: 'wizard',
    });

    const context: DeriveOnboardingStateContext = {
      plan: makeFullPlan(),
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    };

    const state = deriveOnboardingState(context);

    expect(state.phase).toBe<OnboardingPhase>('in-progress');
  });

  test('complete: completion marker present (check marker may or may not be present)', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCompletionMarker(shellPaths, {
      scope: 'user',
      checkedAt: 2000,
      updatedAt: 2000,
      source: 'wizard',
    });

    const context: DeriveOnboardingStateContext = {
      plan: makeFullPlan(),
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    };

    const state = deriveOnboardingState(context);

    expect(state.phase).toBe<OnboardingPhase>('complete');
  });

  test('complete takes priority over in-progress when both markers present', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, {
      scope: 'user',
      checkedAt: 1000,
      source: 'wizard',
    });
    writeOnboardingCompletionMarker(shellPaths, {
      scope: 'user',
      checkedAt: 2000,
      source: 'wizard',
    });

    const context: DeriveOnboardingStateContext = {
      plan: makeFullPlan(),
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    };

    const state = deriveOnboardingState(context);

    expect(state.phase).toBe<OnboardingPhase>('complete');
  });

  test('in-progress stays in-progress when check marker exists but completion file is not present (exists=false)', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, {
      scope: 'user',
      checkedAt: 1000,
      source: 'command',
    });
    // No completion marker written.

    const context: DeriveOnboardingStateContext = {
      plan: makeFullPlan(),
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    };

    const state = deriveOnboardingState(context);

    expect(state.phase).toBe<OnboardingPhase>('in-progress');
    expect(context.completionMarker.exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Blockers and readyToChat
// ---------------------------------------------------------------------------

describe('deriveOnboardingState: blockers and readyToChat', () => {
  test('blockers contains only non-ready autonomy-blocking steps', () => {
    const plan: readonly SetupPlanItem[] = [
      makePlanItem('connected-host-readiness', 'blocked', true),
      makePlanItem('provider-access', 'blocked', true),
      makePlanItem('install-smoke', 'blocked', false),      // not blocksAutonomy
      makePlanItem('local-behavior', 'optional', false),
    ];
    const shellPaths = createShellPaths();

    const state = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    expect(state.blockers).toHaveLength(2);
    expect(state.blockers.map((b) => b.id)).toEqual(['connected-host-readiness', 'provider-access']);
  });

  test('blockers is empty when all autonomy-blocking items are ready', () => {
    const plan: readonly SetupPlanItem[] = [
      makePlanItem('connected-host-readiness', 'ready', true),
      makePlanItem('provider-access', 'ready', true),
      makePlanItem('install-smoke', 'recommended', false),
    ];
    const shellPaths = createShellPaths();

    const state = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    expect(state.blockers).toHaveLength(0);
  });

  test('readyToChat is true when provider-access is ready', () => {
    const plan: readonly SetupPlanItem[] = [
      makePlanItem('connected-host-readiness', 'blocked', true),
      makePlanItem('provider-access', 'ready', true),
    ];
    const shellPaths = createShellPaths();

    const state = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    expect(state.readyToChat).toBe(true);
  });

  test('readyToChat is true when local-model-readiness is ready (no provider-access)', () => {
    const plan: readonly SetupPlanItem[] = [
      makePlanItem('connected-host-readiness', 'blocked', true),
      makePlanItem('provider-access', 'blocked', true),
      makePlanItem('local-model-readiness', 'ready', false),
    ];
    const shellPaths = createShellPaths();

    const state = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    expect(state.readyToChat).toBe(true);
  });

  test('readyToChat is false when neither provider-access nor local-model-readiness is ready', () => {
    const plan: readonly SetupPlanItem[] = [
      makePlanItem('connected-host-readiness', 'blocked', true),
      makePlanItem('provider-access', 'blocked', true),
      makePlanItem('local-model-readiness', 'recommended', false),
    ];
    const shellPaths = createShellPaths();

    const state = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    expect(state.readyToChat).toBe(false);
  });

  test('currentStepId points to first non-ready autonomy blocker', () => {
    const plan: readonly SetupPlanItem[] = [
      makePlanItem('connected-host-readiness', 'blocked', true),
      makePlanItem('provider-access', 'blocked', true),
      makePlanItem('install-smoke', 'blocked', false),
    ];
    const shellPaths = createShellPaths();

    const state = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    expect(state.currentStepId).toBe('connected-host-readiness');
  });

  test('currentStepId falls back to first non-ready step when no autonomy blockers remain', () => {
    const plan: readonly SetupPlanItem[] = [
      makePlanItem('connected-host-readiness', 'ready', true),
      makePlanItem('provider-access', 'ready', true),
      makePlanItem('install-smoke', 'recommended', false),
      makePlanItem('local-behavior', 'optional', false),
    ];
    const shellPaths = createShellPaths();

    const state = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    expect(state.currentStepId).toBe('install-smoke');
  });

  test('currentStepId is null when all steps are ready', () => {
    const shellPaths = createShellPaths();

    const state = deriveOnboardingState({
      plan: makeAllReadyPlan(),
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    expect(state.currentStepId).toBeNull();
  });

  test('progressLabel reflects ready count', () => {
    const plan: readonly SetupPlanItem[] = [
      makePlanItem('connected-host-readiness', 'ready', true),
      makePlanItem('provider-access', 'blocked', true),
      makePlanItem('install-smoke', 'recommended', false),
    ];
    const shellPaths = createShellPaths();

    const state = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    expect(state.progressLabel).toBe('1 of 3 ready');
  });
});

// ---------------------------------------------------------------------------
// categoryId mapping
// ---------------------------------------------------------------------------

describe('deriveOnboardingState: categoryId mapping', () => {
  test('every step the full plan can emit has a non-empty categoryId', () => {
    const shellPaths = createShellPaths();
    const plan = makeFullPlan();

    const state = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    for (const step of state.steps) {
      expect(step.categoryId, `step ${step.id} should have a non-empty categoryId`).toBeTruthy();
    }
  });

  test('provider-access maps to account-model', () => {
    const shellPaths = createShellPaths();
    const state = deriveOnboardingState({
      plan: [makePlanItem('provider-access', 'blocked', true)],
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });
    expect(state.steps[0]?.categoryId).toBe('account-model');
  });

  test('local-model-readiness maps to account-model', () => {
    const shellPaths = createShellPaths();
    const state = deriveOnboardingState({
      plan: [makePlanItem('local-model-readiness', 'recommended', false)],
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });
    expect(state.steps[0]?.categoryId).toBe('account-model');
  });

  test('vibe-personality maps to assistant-behavior', () => {
    const shellPaths = createShellPaths();
    const state = deriveOnboardingState({
      plan: [makePlanItem('vibe-personality', 'recommended', false)],
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });
    expect(state.steps[0]?.categoryId).toBe('assistant-behavior');
  });

  test('local-behavior maps to onboarding-context', () => {
    const shellPaths = createShellPaths();
    const state = deriveOnboardingState({
      plan: [makePlanItem('local-behavior', 'optional', false)],
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });
    expect(state.steps[0]?.categoryId).toBe('onboarding-context');
  });

  test('communication-channels maps to onboarding-channels', () => {
    const shellPaths = createShellPaths();
    const state = deriveOnboardingState({
      plan: [makePlanItem('communication-channels', 'optional', false)],
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });
    expect(state.steps[0]?.categoryId).toBe('onboarding-channels');
  });

  test('automation-review maps to tools-permissions', () => {
    const shellPaths = createShellPaths();
    const state = deriveOnboardingState({
      plan: [makePlanItem('automation-review', 'optional', false)],
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });
    expect(state.steps[0]?.categoryId).toBe('tools-permissions');
  });

  test('unknown plan item id defaults to setup category', () => {
    const shellPaths = createShellPaths();
    const state = deriveOnboardingState({
      plan: [makePlanItem('some-future-step', 'recommended', false)],
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });
    expect(state.steps[0]?.categoryId).toBe('setup');
  });

  test('all plan item ids in PLAN_ITEM_CATEGORY_MAP are covered by the full plan', () => {
    // Verify the full plan emits all the key mapped items so the mapping table stays exercised.
    const plan = makeFullPlan();
    const coveredIds = new Set(plan.map((item) => item.id));
    const knownMappedIds = [
      'connected-host-readiness',
      'connected-host-auth',
      'goodvibes-settings-import',
      'provider-access',
      'install-smoke',
      'local-model-readiness',
      'agent-knowledge',
      'vibe-personality',
      'local-behavior',
      'communication-channels',
      'automation-review',
      'browser-desktop-control',
      'sudo-execution-posture',
      'build-delegation',
      'finish-onboarding',
    ];
    for (const id of knownMappedIds) {
      expect(coveredIds.has(id), `plan should include item ${id}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Recap content
// ---------------------------------------------------------------------------

describe('deriveOnboardingState: recap', () => {
  test('recap headline changes by phase', () => {
    const shellPaths = createShellPaths();
    const plan = makeFullPlan();

    const fresh = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });
    expect(fresh.recap.headline).toContain('Getting started');

    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });
    const inProgress = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });
    expect(inProgress.recap.headline).toContain('in progress');

    writeOnboardingCompletionMarker(shellPaths, { scope: 'user', checkedAt: 2000, source: 'wizard' });
    const complete = deriveOnboardingState({
      plan: makeAllReadyPlan(),
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });
    expect(complete.recap.headline).toContain("You're set up");
  });

  test('recap lines include ready step labels', () => {
    const plan: readonly SetupPlanItem[] = [
      makePlanItem('connected-host-readiness', 'ready', true),
      makePlanItem('provider-access', 'ready', true),
      makePlanItem('install-smoke', 'recommended', false),
    ];
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });

    const state = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    expect(state.recap.lines.length).toBeGreaterThanOrEqual(1);
    // Ready steps appear as lines.
    const labelLines = state.recap.lines.filter((l) => l.startsWith('Label for'));
    expect(labelLines.length).toBe(2);
  });

  test('recap includes try prompt for non-fresh phases', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });

    const state = deriveOnboardingState({
      plan: makeAllReadyPlan(),
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    const hasPromptLine = state.recap.lines.some((l) => l.toLowerCase().includes('try'));
    expect(hasPromptLine).toBe(true);
  });

  test('recap includes capability examples when model is ready (in-progress)', () => {
    const plan: readonly SetupPlanItem[] = [
      makePlanItem('provider-access', 'ready', true),
      makePlanItem('connected-host-readiness', 'blocked', true),
    ];
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });

    const state = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    // Should include always-safe capability examples (research, draft, summarize).
    const hasCapabilityLine = state.recap.lines.some((l) =>
      l.toLowerCase().includes('research') && l.toLowerCase().includes('draft'),
    );
    expect(hasCapabilityLine).toBe(true);
  });

  test('recap capability examples omit channel-dependent features when channels not ready', () => {
    const plan: readonly SetupPlanItem[] = [
      makePlanItem('provider-access', 'ready', true),
      makePlanItem('communication-channels', 'optional', false), // not ready
    ];
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });

    const state = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    // Should NOT include reminders/messaging when channels lane is not ready.
    const hasChannelLine = state.recap.lines.some((l) =>
      l.toLowerCase().includes('reminders') && l.toLowerCase().includes('messages'),
    );
    expect(hasChannelLine).toBe(false);
  });

  test('recap capability examples include reminders/messaging when channels ready', () => {
    const plan: readonly SetupPlanItem[] = [
      makePlanItem('provider-access', 'ready', true),
      makePlanItem('communication-channels', 'ready', false),
    ];
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });

    const state = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    // Should include reminders/messaging when channels lane IS ready.
    const hasChannelLine = state.recap.lines.some((l) =>
      l.toLowerCase().includes('reminders') && l.toLowerCase().includes('messages'),
    );
    expect(hasChannelLine).toBe(true);
  });

  test('recap does not include capability examples when model is not ready', () => {
    const plan: readonly SetupPlanItem[] = [
      makePlanItem('provider-access', 'blocked', true),
      makePlanItem('local-model-readiness', 'recommended', false),
    ];
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });

    const state = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    // No capability examples without a model route.
    const hasCapabilityLine = state.recap.lines.some((l) =>
      l.toLowerCase().includes('research') && l.toLowerCase().includes('draft'),
    );
    expect(hasCapabilityLine).toBe(false);
  });

  test('recap has at least one line even with no ready steps', () => {
    const plan: readonly SetupPlanItem[] = [
      makePlanItem('connected-host-readiness', 'blocked', true),
      makePlanItem('provider-access', 'blocked', true),
    ];
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });

    const state = deriveOnboardingState({
      plan,
      checkMarker: readOnboardingCheckMarker(shellPaths),
      completionMarker: readOnboardingCompletionMarker(shellPaths),
    });

    // The 'in-progress' phase appends a 'try this' prompt line.
    expect(state.recap.lines.length).toBeGreaterThanOrEqual(1);
  });
});
