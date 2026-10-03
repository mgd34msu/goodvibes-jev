import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext } from '../../input/command-registry.ts';
import { AgentWorkspace } from '../../input/agent-workspace.ts';
import { createShellPathService } from '@/runtime/index.ts';
import {
  readOnboardingCheckMarker,
  readOnboardingCompletionMarker,
  writeOnboardingCheckMarker,
} from '../../runtime/onboarding/index.ts';
import type { AgentSetupWizardStep } from '../../agent/setup-wizard.ts';
import type { AgentWorkspaceRuntimeSnapshot } from '../../input/agent-workspace-types.ts';
import {
  computeOnboardingStateFromSnapshot,
  updateRevealedOnboardingCategories,
  deriveOnboardingEntry,
} from '../../input/agent-workspace-onboarding-state.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wizardStep(
  id: string,
  sourceStatus: AgentSetupWizardStep['sourceStatus'],
  label = id,
): AgentSetupWizardStep {
  return { id, label, sourceStatus, detail: '', userRoute: '', modelRoute: '', status: 'pending', actionId: '' , backtrackRoute: null };
}

// Build a minimal AgentWorkspaceRuntimeSnapshot with wizard steps
function snapshotWithSteps(
  steps: AgentSetupWizardStep[],
): AgentWorkspaceRuntimeSnapshot {
  return {
    setupWizard: { steps } as unknown as AgentWorkspaceRuntimeSnapshot['setupWizard'],
  } as unknown as AgentWorkspaceRuntimeSnapshot;
}

function tempShellPaths() {
  const root = makeProjectTempDir('gv-onboarding-test');
  const workingDirectory = join(root, 'ws');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  return createShellPathService({ workingDirectory, homeDirectory });
}

// ---------------------------------------------------------------------------
// Progressive sequencing
// ---------------------------------------------------------------------------

describe('updateRevealedOnboardingCategories', () => {
  test('always reveals setup regardless of step readiness', () => {
    const steps = [
      wizardStep('connected-host-auth', 'blocked'),
      wizardStep('provider-model', 'blocked'),
    ];
    const snap = snapshotWithSteps(steps);
    const obs = computeOnboardingStateFromSnapshot(snap, undefined);
    expect(obs).not.toBeNull();

    const revealed = new Set<string>();
    updateRevealedOnboardingCategories(obs!, revealed);
    expect(revealed.has('setup')).toBe(true);
    expect(revealed.has('account-model')).toBe(false);
  });

  test('reveals account-model category when readyToChat is true (provider-access ready)', () => {
    const steps = [
      wizardStep('provider-model', 'ready'),  // maps to provider-access → readyToChat
      wizardStep('connected-host-auth', 'blocked'),
    ];
    const snap = snapshotWithSteps(steps);
    const obs = computeOnboardingStateFromSnapshot(snap, undefined);
    expect(obs?.readyToChat).toBe(true);

    const revealed = new Set<string>();
    updateRevealedOnboardingCategories(obs!, revealed);
    expect(revealed.has('account-model')).toBe(true);
  });

  test('reveal set is monotonic: previously revealed categories are not removed', () => {
    const stepsReady = [wizardStep('provider-model', 'ready')];
    const obsReady = computeOnboardingStateFromSnapshot(snapshotWithSteps(stepsReady), undefined)!;

    const revealed = new Set<string>();
    updateRevealedOnboardingCategories(obsReady, revealed);
    expect(revealed.has('account-model')).toBe(true);

    // Now simulate readyToChat going false (e.g. snapshot changed)
    const stepsBlocked = [wizardStep('provider-model', 'blocked')];
    const obsBlocked = computeOnboardingStateFromSnapshot(snapshotWithSteps(stepsBlocked), undefined)!;
    // Re-run update, account-model should NOT be removed (monotonic)
    updateRevealedOnboardingCategories(obsBlocked, revealed);
    expect(revealed.has('account-model')).toBe(true);
  });

  test('returns null when snapshot has no wizard steps', () => {
    const snap = snapshotWithSteps([]);
    expect(computeOnboardingStateFromSnapshot(snap, undefined)).toBeNull();
  });

  // Integration test: resume target category is revealed when phase is in-progress
  //
  // This is the regression case that was missing and made the navigation bug invisible.
  // Before the fix, updateRevealedOnboardingCategories only added categories for
  // *ready* steps, so the resume target (a non-ready blocker) was never revealed.
  // workspace.open() would then fail to navigate to it, staying on 'setup' while
  // the status line claimed 'Picking up where you left off: <other>'.
  test('reveals resume target category when phase is in-progress (non-setup blocker)', () => {
    // provider-model is blocked and non-ready; it maps to the 'account-model' category.
    const steps = [
      wizardStep('connected-host-auth', 'ready'),  // maps to 'setup' category, already done
      wizardStep('provider-model', 'blocked'),     // maps to 'account-model' via provider-access
    ];
    const snap = snapshotWithSteps(steps);
    const shellPaths = tempShellPaths();
    // Write check marker → phase becomes 'in-progress'
    writeOnboardingCheckMarker(shellPaths);

    const obs = computeOnboardingStateFromSnapshot(snap, shellPaths);
    expect(obs).not.toBeNull();
    expect(obs!.phase).toBe('in-progress');

    // currentStepId resolves to provider-access (the first non-ready blocker)
    expect(obs!.currentStepId).toBeTruthy();
    const resumeStep = obs!.steps.find((s) => s.id === obs!.currentStepId);
    expect(resumeStep).toBeTruthy();
    expect(resumeStep!.categoryId).toBe('account-model');

    // The entry correctly identifies the resume category
    const entry = deriveOnboardingEntry(obs!);
    expect(entry.categoryId).toBe('account-model');
    expect(entry.status).toContain('Picking up where you left off');

    // After the fix: updateRevealedOnboardingCategories must reveal the resume target.
    // Before the fix it would NOT be revealed (provider-model is blocked, not ready),
    // so workspace.open() would silently stay on 'setup'.
    const revealed = new Set<string>();
    updateRevealedOnboardingCategories(obs!, revealed);
    expect(revealed.has('account-model')).toBe(true);

    // Confirm that the revealed set contains entry.categoryId, the exact check
    // that workspace.open() does when selecting the category index.
    expect(revealed.has(entry.categoryId!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resume / entry navigation
// ---------------------------------------------------------------------------

describe('deriveOnboardingEntry', () => {
  test('returns resume status and category when phase is in-progress with a currentStepId', () => {
    // provider-model → provider-access → maps to account-model category
    const steps = [
      wizardStep('connected-host-auth', 'ready'),
      wizardStep('provider-model', 'blocked'),
    ];
    const snap = snapshotWithSteps(steps);
    const shellPaths = tempShellPaths();
    // Write the check marker to put the state into 'in-progress' phase
    writeOnboardingCheckMarker(shellPaths);
    const obs = computeOnboardingStateFromSnapshot(snap, shellPaths);
    expect(obs?.phase).toBe('in-progress');
    expect(obs?.currentStepId).toBeTruthy();

    const entry = deriveOnboardingEntry(obs!);
    // In-progress phase: entry should have a categoryId and resume-style status
    expect(entry.status).toContain('Picking up where you left off');
    expect(typeof entry.categoryId).toBe('string');
  });

  test('returns progress status without categoryId when phase is fresh', () => {
    const steps = [
      wizardStep('connected-host-auth', 'blocked'),
    ];
    const obs = computeOnboardingStateFromSnapshot(snapshotWithSteps(steps), undefined)!;
    expect(obs.phase).toBe('fresh');

    const entry = deriveOnboardingEntry(obs);
    expect(entry.categoryId).toBeUndefined();
    expect(entry.status).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AgentWorkspace integration: ONBOARDING-filtered category sequencing
// ---------------------------------------------------------------------------

describe('AgentWorkspace ONBOARDING sequencing', () => {
  test('default open (no onlyGroup) shows all categories regardless of readiness', () => {
    const workspace = new AgentWorkspace();
    const ctx = {
      executeCommand: async () => true,
      print: () => undefined,
    } as unknown as CommandContext;
    workspace.open(ctx, () => undefined);
    // Should have multiple category groups
    const groups = new Set(workspace.categories.map((c) => c.group));
    expect(groups.size).toBeGreaterThan(1);
  });

  test('direct category open (no onlyGroup) resolves onboarding-voice-media and home', () => {
    const workspace = new AgentWorkspace();
    const ctx = {
      executeCommand: async () => true,
      print: () => undefined,
    } as unknown as CommandContext;
    // These categories must be reachable via direct open
    workspace.open(ctx, () => undefined, 'onboarding-voice-media');
    expect(workspace.selectedCategory.id).toBe('onboarding-voice-media');

    workspace.open(ctx, () => undefined, 'home');
    expect(workspace.selectedCategory.id).toBe('home');
  });
});

// ---------------------------------------------------------------------------
// Completion recap
// ---------------------------------------------------------------------------

describe('AgentWorkspace completion recap', () => {
  test('completeOnboarding writes markers before showing recap; final confirm closes', () => {
    const root = makeProjectTempDir('gv-onboarding-recap');
    const workingDirectory = join(root, 'ws');
    const homeDirectory = join(root, 'home');
    mkdirSync(workingDirectory, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
    const workspace = new AgentWorkspace();
    let dismissed = false;
    const ctx = {
      executeCommand: async () => true,
      print: () => undefined,
      workspace: { shellPaths },
      dismissAgentWorkspace: () => {
        dismissed = true;
        workspace.close();
        return true;
      },
    } as unknown as CommandContext;

    workspace.open(ctx, () => undefined, 'finish');

    // --- First activation: writes markers + shows recap ---
    workspace.activateSelected();

    const checkMarker = readOnboardingCheckMarker(shellPaths, 'user');
    const completionMarker = readOnboardingCompletionMarker(shellPaths, 'user');
    expect(checkMarker.exists).toBe(true);
    expect(completionMarker.exists).toBe(true);
    expect(completionMarker.payload?.source).toBe('wizard');
    expect(completionMarker.payload?.mode).toBe('new');
    expect(completionMarker.payload?.workspaceRoot).toBe(shellPaths.workingDirectory);
    expect(workspace.lastActionResult?.kind).toBe('recap');
    expect(workspace.active).toBe(true); // still showing recap

    // --- Second activation: confirms recap and dismisses ---
    workspace.activateSelected();

    expect(dismissed).toBe(true);
    expect(workspace.active).toBe(false);
  });

  test('completeOnboarding shows error when shellPaths is unavailable', () => {
    const workspace = new AgentWorkspace();
    const ctx = {
      executeCommand: async () => true,
      print: () => undefined,
      // no workspace.shellPaths
    } as unknown as CommandContext;

    workspace.open(ctx, () => undefined, 'finish');
    workspace.activateSelected();

    expect(workspace.lastActionResult?.kind).toBe('error');
    expect(workspace.active).toBe(true); // error does not close
  });
});
