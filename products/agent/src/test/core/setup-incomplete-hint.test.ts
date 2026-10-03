import { describe, expect, test } from 'bun:test';
import { buildSetupIncompleteHint } from '../../core/setup-incomplete-hint.ts';
import type { OnboardingState, OnboardingStep } from '../../runtime/onboarding/onboarding-state.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(id: string, status: OnboardingStep['status'] = 'blocked', blocksAutonomy = true): OnboardingStep {
  return {
    id,
    label: `Label for ${id}`,
    status,
    blocksAutonomy,
    nextLabel: `Fix ${id}`,
    categoryId: 'setup',
  };
}

function makeState(overrides: Partial<OnboardingState> = {}): OnboardingState {
  const steps: OnboardingStep[] = (overrides.steps as OnboardingStep[] | undefined) ?? [
    makeStep('provider-access', 'blocked', true),
  ];
  return {
    phase: 'in-progress',
    steps,
    currentStepId: steps[0]?.id ?? null,
    progressLabel: '2 of 5 ready',
    blockers: steps.filter((s) => s.status !== 'ready' && s.blocksAutonomy),
    readyToChat: true,
    recap: { headline: 'Setup is in progress.', lines: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Phase gating: fresh and complete return null
// ---------------------------------------------------------------------------

describe('buildSetupIncompleteHint: phase gating', () => {
  test('returns null for phase fresh', () => {
    const state = makeState({ phase: 'fresh' });
    expect(buildSetupIncompleteHint(state)).toBeNull();
  });

  test('returns null for phase complete', () => {
    const state = makeState({ phase: 'complete' });
    expect(buildSetupIncompleteHint(state)).toBeNull();
  });

  test('returns non-null for phase in-progress', () => {
    const state = makeState({ phase: 'in-progress' });
    expect(buildSetupIncompleteHint(state)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// in-progress with readyToChat = true
// ---------------------------------------------------------------------------

describe('buildSetupIncompleteHint: in-progress, ready to chat', () => {
  test('line 1 mentions setup is not finished or still in progress', () => {
    const state = makeState({ readyToChat: true });
    const result = buildSetupIncompleteHint(state);
    expect(result).not.toBeNull();
    const line = result!.lines[0]!;
    expect(line.toLowerCase()).toMatch(/setup|not finished|in progress|finishing/);
  });

  test('line 1 does not include progress label (dropped to avoid misleading counts)', () => {
    const state = makeState({ readyToChat: true, progressLabel: '2 of 5 ready' });
    const result = buildSetupIncompleteHint(state);
    // progressLabel is intentionally suppressed, the startup minimal plan's
    // "N of 2" count understates real progress and misleads the user.
    expect(result!.lines[0]).not.toContain('2 of 5 ready');
    expect(result!.lines[0]).not.toContain('of 5 ready');
  });

  test('line 1 mentions /agent', () => {
    const state = makeState({ readyToChat: true });
    const result = buildSetupIncompleteHint(state);
    expect(result!.lines[0]).toContain('/agent');
  });

  test('line 1 says chat still works', () => {
    const state = makeState({ readyToChat: true });
    const result = buildSetupIncompleteHint(state);
    const line = result!.lines[0]!.toLowerCase();
    expect(line).toMatch(/chat|now|still|finishing/);
  });

  test('includes blocker label when blockers present', () => {
    const blocker = makeStep('communication-channels', 'blocked', true);
    (blocker as { nextLabel: string }).nextLabel = 'set up a notification channel';
    const state = makeState({
      readyToChat: true,
      steps: [blocker],
      blockers: [blocker],
    });
    const result = buildSetupIncompleteHint(state);
    expect(result!.lines[0]).toContain('notification channel');
  });

  test('at most 2 lines for in-progress with host ready', () => {
    const state = makeState({ readyToChat: true });
    const result = buildSetupIncompleteHint(state, true);
    expect(result!.lines.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// in-progress with readyToChat = false (model-first lead)
// ---------------------------------------------------------------------------

describe('buildSetupIncompleteHint: in-progress, not ready to chat', () => {
  test('leads with pick a model prompt', () => {
    const state = makeState({ readyToChat: false });
    const result = buildSetupIncompleteHint(state);
    expect(result).not.toBeNull();
    const line = result!.lines[0]!.toLowerCase();
    expect(line).toMatch(/model|pick/);
  });

  test('still mentions /agent', () => {
    const state = makeState({ readyToChat: false });
    const result = buildSetupIncompleteHint(state);
    expect(result!.lines[0]).toContain('/agent');
  });

  test('does not say chat works when readyToChat is false', () => {
    const state = makeState({ readyToChat: false });
    const result = buildSetupIncompleteHint(state);
    // Should NOT include misleading claim that chat still works
    expect(result!.lines[0]).not.toMatch(/you can chat now/);
  });
});

// ---------------------------------------------------------------------------
// Host readiness line
// ---------------------------------------------------------------------------

describe('buildSetupIncompleteHint: host readiness line', () => {
  test('hostReady true appends assistant service active line', () => {
    const state = makeState({ readyToChat: true });
    const result = buildSetupIncompleteHint(state, true);
    expect(result!.lines.length).toBe(2);
    const hostLine = result!.lines[1]!.toLowerCase();
    expect(hostLine).toMatch(/active|running/);
    // Must NOT say it is not running
    expect(hostLine).not.toMatch(/not running|isn't running/);
  });

  test('hostReady false appends assistant service not running line', () => {
    const state = makeState({ readyToChat: true });
    const result = buildSetupIncompleteHint(state, false);
    expect(result!.lines.length).toBe(2);
    const hostLine = result!.lines[1]!.toLowerCase();
    expect(hostLine).toMatch(/not running|isn't running/);
  });

  test('hostReady null omits the host line', () => {
    const state = makeState({ readyToChat: true });
    const result = buildSetupIncompleteHint(state, null);
    expect(result!.lines.length).toBe(1);
  });

  test('hostReady undefined omits the host line', () => {
    const state = makeState({ readyToChat: true });
    const result = buildSetupIncompleteHint(state, undefined);
    expect(result!.lines.length).toBe(1);
  });

  test('hostReady undefined (default) omits the host line', () => {
    const state = makeState({ readyToChat: true });
    const result = buildSetupIncompleteHint(state);
    expect(result!.lines.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// MINOR-1: local-model-readiness ready while provider-access blocked
// ---------------------------------------------------------------------------

describe('buildSetupIncompleteHint: local-model-readiness ready, provider blocked', () => {
  /**
   * Simulate the OnboardingState that deriveOnboardingState produces when:
   *   - provider-access: 'blocked'
   *   - local-model-readiness: 'ready'
   * In this case deriveReadyToChat returns true (provider OR local).
   */
  function makeLocalReadyState(): OnboardingState {
    const localStep = makeStep('local-model-readiness', 'ready', false);
    (localStep as { label: string }).label = 'Local model';
    const providerStep = makeStep('provider-access', 'blocked', true);
    (providerStep as { label: string }).label = 'Model access';
    return {
      phase: 'in-progress',
      steps: [providerStep, localStep],
      currentStepId: providerStep.id,
      progressLabel: '1 of 2 ready',
      blockers: [providerStep],
      readyToChat: true, // local model satisfies readyToChat
      recap: { headline: 'Setup is in progress.', lines: [] },
    };
  }

  test('does NOT lead with \'pick a model\' when local route is ready', () => {
    const state = makeLocalReadyState();
    const result = buildSetupIncompleteHint(state);
    expect(result).not.toBeNull();
    const line = result!.lines[0]!.toLowerCase();
    // Must NOT say 'pick a model' when local route makes chat available
    expect(line).not.toMatch(/pick a model/);
  });

  test('says chat works when local model is ready but provider is blocked', () => {
    const state = makeLocalReadyState();
    const result = buildSetupIncompleteHint(state);
    expect(result).not.toBeNull();
    const line = result!.lines[0]!.toLowerCase();
    // Should indicate chat is possible right now
    expect(line).toMatch(/chat|now/);
  });

  test('mentions /agent to continue setup', () => {
    const state = makeLocalReadyState();
    const result = buildSetupIncompleteHint(state);
    expect(result!.lines[0]).toContain('/agent');
  });

  test('no banned jargon in local-ready hint', () => {
    const BANNED = [/\bWRFC\b/, /\bdaemon\b/i, /\bmodelRoute\b/, /action:"/];
    const state = makeLocalReadyState();
    const result = buildSetupIncompleteHint(state);
    if (!result) return;
    for (const line of result.lines) {
      for (const pattern of BANNED) {
        expect(pattern.test(line), `Banned jargon ${pattern}: "${line}"`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Plain-language check: no banned jargon in any hint line
// ---------------------------------------------------------------------------

const BANNED_JARGON = [
  /\bWRFC\b/,
  /\bdaemon\b/i,
  /\bposture\b/i,
  /\bmodelRoute\b/,
  /\bagent_harness\b/,
  /action:"/,
  /mode:"/,
  /\bcli\b/i,
];

describe('buildSetupIncompleteHint: plain language', () => {
  const scenarios: Array<[string, Partial<OnboardingState>, boolean | null | undefined]> = [
    ['in-progress, readyToChat, no host signal', { readyToChat: true }, undefined],
    ['in-progress, not readyToChat, no host signal', { readyToChat: false }, undefined],
    ['in-progress, readyToChat, host ready', { readyToChat: true }, true],
    ['in-progress, readyToChat, host not ready', { readyToChat: true }, false],
  ];

  for (const [label, stateOverrides, hostReady] of scenarios) {
    test(`no jargon: ${label}`, () => {
      const state = makeState(stateOverrides);
      const result = buildSetupIncompleteHint(state, hostReady);
      if (result === null) return; // null is fine
      for (const line of result.lines) {
        for (const pattern of BANNED_JARGON) {
          expect(
            pattern.test(line),
            `Hint line contains banned jargon ${pattern}: "${line}"`,
          ).toBe(false);
        }
      }
    });
  }

  test('host line uses "assistant service" phrasing, not technical terms', () => {
    const state = makeState({ readyToChat: true });
    const resultTrue = buildSetupIncompleteHint(state, true);
    const resultFalse = buildSetupIncompleteHint(state, false);
    // Neither line may use the word "daemon"
    for (const r of [resultTrue, resultFalse]) {
      if (!r) continue;
      for (const line of r.lines) {
        expect(line).not.toMatch(/\bdaemon\b/i);
      }
    }
  });
});
