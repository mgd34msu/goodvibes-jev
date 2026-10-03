import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { ConfigModalSurface } from '../../../input/config-modal-types.ts';
import { createPlanningModalSurface, type PlanningModalService } from '../../../views/modals/planning-modal.ts';
import type { ProjectPlanningState, ProjectPlanningStatus } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { actionCtx, captureCommands, findAction, tabText } from './modal-surface-test-helpers.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previous = installJudgmentPort(fakePort((name) => {
    if (!['scope', 'tasks', 'verification', 'approval', 'specific'].includes(name)) throw new Error(`Unexpected planning fixture: ${name}`);
    return noulAnswer(['scope', 'approval', 'specific'].includes(name) ? 0.99 : 0.01);
  }).port);
});
afterEach(() => { installJudgmentPort(previous); });

function answerRow(surface: ConfigModalSurface, id: string) {
  const row = surface.buildView().tabs[0]!.rows.find((row) => row.id.endsWith(`:${id}`));
  if (!row) throw new Error(`Expected planning answer ${id}`);
  return row;
}

async function flush(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 0)); }

const REVISION = Object.freeze({ sourceId: 'planning-source-fixture', generation: 'a'.repeat(64) });
const TARGET = ['--selected-revision', 'state-1', REVISION.sourceId, REVISION.generation];

const FIXED_STATUS: ProjectPlanningStatus = { ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', passiveOnly: true, counts: { states: 1, decisions: 0, languageArtifacts: 0, workPlans: 0, workPlanTasks: 0 }, capabilities: [] };

function noQuestionState(): ProjectPlanningState {
  return { id: 'state-1', projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', goal: 'Fixture goal', knownContext: [], openQuestions: [], answeredQuestions: [], decisions: [], assumptions: [], constraints: [], risks: [], tasks: [], dependencies: [], verificationGates: [], agentAssignments: [], readiness: 'executable', executionApproved: false, createdAt: 0, updatedAt: 0 };
}
function serviceWithState(state: ProjectPlanningState | null): PlanningModalService {
  return {
    status: async () => FIXED_STATUS,
    getState: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', state, revision: REVISION }),
    listDecisions: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', decisions: [] }),
    getLanguage: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', language: null }),
    evaluate: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', readiness: state?.readiness ?? 'not-ready', gaps: [], state: state ?? noQuestionState() }),
  };
}
async function warm(service: PlanningModalService) {
  const surface = createPlanningModalSurface({ service, projectId: 'proj-1' });
  surface.onOpen?.(() => {});
  await flush();
  return surface;
}

describe('planning modal surface', () => {
  test('surface identity matches the project-planning -> planning-modal redirect target', () => {
    expect(createPlanningModalSurface({ service: serviceWithState(null), projectId: 'proj-1' }).name).toBe('planning-modal');
  });

  test('loading placeholder before the async load resolves, then the real state after', async () => {
    const surface = createPlanningModalSurface({ service: serviceWithState(noQuestionState()), projectId: 'proj-1' });
    surface.onOpen?.(() => {});
    expect(tabText(surface.buildView(), 'planning').toLowerCase()).toContain('loading');
    await flush();
    const loaded = tabText(surface.buildView(), 'planning');
    expect(loaded).toContain('readiness executable');
    expect(loaded).toContain('Fixture goal');
  });

  test('no-state case names the gap honestly instead of showing empty artifact sections', async () => {
    const text = tabText((await warm(serviceWithState(null))).buildView(), 'planning');
    expect(text).toContain('No project planning state has been saved for this workspace.');
  });

  test('an open question renders answer actions; approve row routes to /project-plan approve', async () => {
    const state: ProjectPlanningState = { ...noQuestionState(), readiness: 'needs-user-input', openQuestions: [{ id: 'q1', prompt: 'Is execution approved?', status: 'open' }] };
    const surface = await warm(serviceWithState(state));
    const view = surface.buildView();
    const text = tabText(view, 'planning');
    expect(text).toContain('Is execution approved?');
    expect(text).toContain('Approve execution');
    // no more reseed approximation note; the answer paths are real now.
    expect(text).not.toContain('reseeds the plan goal');
    expect(view.tabs[0]!.rows.some((r) => r.id.endsWith(':approve-execution'))).toBe(true);

    expect(findAction(surface, 'submit')?.enabledFor?.(null, 'planning')).toBe(true);
    const cap = captureCommands();
    surface.onAction?.('submit', actionCtx(answerRow(surface, 'approve-execution'), cap.extra));
    await flush();
    expect(cap.calls).toEqual([['project-plan', ['approve', ...TARGET]]]);
  });

  // a canned answer to a REAL open question records via /project-plan answer <id> <text>.
  test('a canned answer to a real open question dispatches /project-plan answer <id> <text>', async () => {
    const state: ProjectPlanningState = { ...noQuestionState(), readiness: 'needs-user-input', openQuestions: [{ id: 'q1', prompt: 'What is the scope?', status: 'open' }] };
    const surface = await warm(serviceWithState(state));
    const cap = captureCommands();
    surface.onAction?.('submit', actionCtx(answerRow(surface, 'scope-focused-first-pass'), cap.extra));
    await flush();
    expect(cap.calls.length).toBe(1);
    const [name, args] = cap.calls[0]!;
    expect(name).toBe('project-plan');
    expect(args[0]).toBe('answer');
    expect(args.slice(1, 5)).toEqual(TARGET);
    expect(args[5]).toBe('q1');
    expect(args.slice(6).join(' ')).toBe('Use a focused first-pass scope for this goal.');
  });

  // an answer to a SYNTHETIC readiness question (no open-question record
  // to target) is submitted to chat via submitInput, and the modal CLOSES BEFORE
  // the turn starts (modal-liveness ordering guard). No /plan command is dispatched.
  test('an answer to a synthetic question uses submitInput and closes the modal first', async () => {
    const state: ProjectPlanningState = { ...noQuestionState(), readiness: 'needs-user-input', openQuestions: [] };
    const syntheticQuestion = { id: 'missing-scope', prompt: 'What is in scope for this pass?', status: undefined };
    const service: PlanningModalService = {
      ...serviceWithState(state),
      evaluate: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', readiness: 'needs-user-input', gaps: [], nextQuestion: syntheticQuestion, state }),
    };
    const surface = await warm(service);
    const cap = captureCommands();
    const order: string[] = [];
    // Captured on an object (not a bare `let`) so TS tracks the string | null
    // union across the callback boundary instead of narrowing to the initializer.
    const submission: { text: string | null } = { text: null };
    surface.onAction?.('submit', actionCtx(answerRow(surface, 'scope-focused-first-pass'), {
      ...cap.extra,
      close: () => order.push('close'),
      submitInput: (t) => { order.push('submit'); submission.text = t; },
    }));
    await flush();
    expect(cap.calls).toEqual([]); // no /project-plan command ; this is a real chat turn
    expect(submission.text).toBe('Use a focused first-pass scope for this goal.');
    expect(order).toEqual(['close', 'submit']); // close BEFORE the turn starts
  });

  test('custom answer returns to the existing chat composer without an automatic submission', async () => {
    const state: ProjectPlanningState = { ...noQuestionState(), openQuestions: [{ id: 'q1', prompt: 'What is the scope?', status: 'open' }] };
    const surface = await warm(serviceWithState(state));
    const printed: string[] = [];
    const cap = captureCommands();
    const order: string[] = [];
    surface.onAction?.('submit', actionCtx(answerRow(surface, 'custom'), { ...cap.extra, close: () => order.push('close'), print: (m) => { order.push('print'); printed.push(m); }, submitInput: () => order.push('submit') }));
    expect(cap.calls).toEqual([]);
    expect(printed).toEqual(['Type your answer in the chat composer.']);
    expect(order).toEqual(['close', 'print']);
  });

  test('top-level approve action (no open question) routes to /project-plan approve', async () => {
    const surface = await warm(serviceWithState(noQuestionState()));
    const cap = captureCommands();
    surface.onAction?.('approve', actionCtx(null, cap.extra));
    await flush();
    expect(cap.calls).toEqual([['project-plan', ['approve', ...TARGET]]]);
  });

  // dismiss is now a first-class CONFIRMED action ('d') that dispatches
  // the real /project-plan dismiss and closes the modal, not a pseudo answer-row.
  test('the dismiss action dispatches /project-plan dismiss and closes the modal', async () => {
    const surface = await warm(serviceWithState(noQuestionState()));
    const cap = captureCommands();
    let closed = 0;
    surface.onAction?.('dismiss', actionCtx(null, { ...cap.extra, close: () => { closed += 1; } }));
    expect(cap.calls).toEqual([['project-plan', ['dismiss']]]);
    expect(closed).toBe(1);
    // It is declared as a confirmed action (host two-press guard).
    expect(findAction(surface, 'dismiss')?.confirm).toBe(true);
  });

  test('there is no pseudo dismiss/close answer-row anymore', async () => {
    const state: ProjectPlanningState = { ...noQuestionState(), readiness: 'needs-user-input', openQuestions: [{ id: 'q1', prompt: 'What is the scope?', status: 'open' }] };
    const view = (await warm(serviceWithState(state))).buildView();
    expect(view.tabs[0]!.rows.some((r) => r.id === 'dismiss-planning')).toBe(false);
    expect(tabText(view, 'planning')).not.toContain('Close (planning unchanged)');
  });
});

// REGRESSION (the /plan → /project-plan rename left the modal dispatching the
// old name): drive the modal's approve/dismiss/answer actions through the REAL
// command registry with the real planning-runtime handlers registered, and
// assert the project-planning handler actually receives them. Then assert that
// dispatching 'plan' with those same arguments would NOT reach project
// planning: it only toggles the session permission mode. A capture mock cannot
// catch this class of bug, which is exactly how it shipped.
describe('planning modal actions through the real command registry', () => {
  interface RegistryHarness {
    registry: import('../../../input/command-registry.ts').CommandRegistry;
    commandContext: import('../../../input/command-registry.ts').CommandContext;
    upsertCalls: Array<Record<string, unknown>>;
    answerCalls: Array<Record<string, unknown>>;
    dismissCalls: number;
    permissionModeSets: string[];
    executeCommand: (name: string, args: string[]) => Promise<boolean>;
  }

  async function makeRegistryHarness(openQuestionId?: string): Promise<RegistryHarness> {
    const { CommandRegistry } = await import('../../../input/command-registry.ts');
    const { registerPlanningRuntimeCommands } = await import('../../../input/commands/planning-runtime.ts');
    const upsertCalls: Array<Record<string, unknown>> = [];
    const answerCalls: Array<Record<string, unknown>> = [];
    const harness: RegistryHarness = {
      registry: new CommandRegistry(),
      commandContext: undefined as never,
      upsertCalls,
      answerCalls,
      dismissCalls: 0,
      permissionModeSets: [],
      executeCommand: undefined as never,
    };
    const planningState = {
      id: 'state-1', projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', goal: 'Fixture goal',
      knownContext: [], openQuestions: openQuestionId ? [{ id: openQuestionId, prompt: 'What is the scope?', status: 'open' }] : [],
      answeredQuestions: [], decisions: [], assumptions: [], constraints: [], risks: [], tasks: [],
      dependencies: [], verificationGates: [], agentAssignments: [], readiness: 'executable',
      executionApproved: false, createdAt: 0, updatedAt: 0, metadata: {},
    };
    const projectPlanningService = {
      status: async () => FIXED_STATUS,
      getState: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', state: planningState, revision: REVISION }),
      upsertState: async (input: Record<string, unknown>) => { upsertCalls.push(input); return { ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', state: { ...planningState, executionApproved: true } }; },
      evaluate: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', readiness: 'executable', gaps: [], state: planningState, revision: REVISION }),
      applyStateAction: async (input: { action: Record<string, unknown> }) => {
        if (input.action.kind === 'approve') upsertCalls.push(input);
        else answerCalls.push(input);
        return { ok: true, applied: true, state: planningState, revision: REVISION, question: planningState.openQuestions[0], evaluation: { readiness: 'executable', gaps: [], state: planningState } };
      },
    };
    let permissionsMode = 'prompt';
    harness.commandContext = {
      print: () => {},
      openModal: () => {},
      session: {
        runtime: { model: 'm', provider: 'p', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: 'session' },
        conversationManager: {},
        sessionLineageTracker: { setOriginalTask: () => {} },
      },
      workspace: { projectPlanningService, projectPlanningProjectId: 'proj-1' },
      ops: {
        planManager: {
          getActive: () => null,
          getSummary: () => '',
          list: () => [],
          toMarkdown: () => '',
          dismiss: () => { harness.dismissCalls += 1; return { outcome: 'dismissed' }; },
        },
      },
      provider: {},
      platform: {
        configManager: {
          get: (key: string) => (key === 'permissions.mode' ? permissionsMode : undefined),
          set: (key: string, value: string) => {
            if (key === 'permissions.mode') { permissionsMode = value; harness.permissionModeSets.push(value); }
          },
        },
      },
      extensions: {},
      renderRequest: () => {},
      exit: () => {},
    } as never;
    registerPlanningRuntimeCommands(harness.registry);
    harness.executeCommand = (name, args) => harness.registry.execute(name, args, harness.commandContext);
    return harness;
  }

  test('the approve action reaches the real project-plan handler (revision-bound approval), not permission plan mode', async () => {
    const harness = await makeRegistryHarness();
    const surface = await warm(serviceWithState(noQuestionState()));
    surface.onAction?.('approve', actionCtx(null, { executeCommand: harness.executeCommand }));
    await flush();
    expect(harness.upsertCalls.length).toBe(1);
    expect(harness.upsertCalls[0]).toMatchObject({ expected: { kind: 'revision', revision: REVISION }, action: { kind: 'approve' } });
    expect(harness.permissionModeSets).toEqual([]); // permission mode untouched
  });

  test('the dismiss action reaches the real project-plan handler (planManager.dismiss)', async () => {
    const harness = await makeRegistryHarness();
    const surface = await warm(serviceWithState(noQuestionState()));
    surface.onAction?.('dismiss', actionCtx(null, { executeCommand: harness.executeCommand, close: () => {} }));
    await flush();
    expect(harness.dismissCalls).toBe(1);
    expect(harness.permissionModeSets).toEqual([]);
  });

  test('a canned answer reaches the real project-plan handler (revision-bound answer with the question id)', async () => {
    const harness = await makeRegistryHarness('q1');
    const state: ProjectPlanningState = { ...noQuestionState(), readiness: 'needs-user-input', openQuestions: [{ id: 'q1', prompt: 'What is the scope?', status: 'open' }] };
    const surface = await warm(serviceWithState(state));
    surface.onAction?.('submit', actionCtx(answerRow(surface, 'scope-focused-first-pass'), { executeCommand: harness.executeCommand }));
    await flush();
    expect(harness.answerCalls.length).toBe(1);
    expect(harness.answerCalls[0]).toMatchObject({ expected: { kind: 'revision', revision: REVISION }, action: { kind: 'answer', questionId: 'q1' } });
    expect(String((harness.answerCalls[0]!.action as Record<string, unknown>).answer)).toContain('scope');
    expect(harness.permissionModeSets).toEqual([]);
  });

  test("dispatching 'plan' with the modal's old arguments does NOT reach project planning; it toggles permission mode", async () => {
    const harness = await makeRegistryHarness('q1');
    await harness.executeCommand('plan', ['approve']);
    await harness.executeCommand('plan', ['dismiss']);
    await harness.executeCommand('plan', ['answer', 'q1', 'some', 'answer']);
    expect(harness.upsertCalls).toEqual([]);
    expect(harness.answerCalls).toEqual([]);
    expect(harness.dismissCalls).toBe(0);
    // Each unknown-arg /plan call falls through to togglePlanMode: prompt→plan→prompt→plan.
    expect(harness.permissionModeSets).toEqual(['plan', 'prompt', 'plan']);
  });
});

describe('planning reading lifecycle and operator authority', () => {
  const stateWithQuestion = (prompt = 'What is in scope?'): ProjectPlanningState => ({
    ...noQuestionState(), readiness: 'needs-user-input',
    openQuestions: [{ id: 'q1', prompt, status: 'open' }],
  });
  const rows = (surface: ConfigModalSurface) => surface.buildView().tabs[0]!.rows;
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((ok) => { resolve = ok; });
    return { promise, resolve };
  };

  test('missing, held, and privacy-refused readings preserve manual and explicit operator routes', async () => {
    for (const mode of ['missing', 'held', 'private'] as const) {
      installJudgmentPort(mode === 'missing' ? undefined : fakePort(() => noulAnswer(0.5)).port);
      const state = stateWithQuestion(mode === 'private' ? 'Question with card 4111111111111111' : 'What is the scope?');
      const surface = await warm(serviceWithState(state));
      expect(rows(surface).filter((row) => row.id.startsWith('answer:')).map((row) => row.id.split(':').at(-1))).toEqual(['ask-narrower', 'custom']);
      const cap = captureCommands();
      surface.onAction?.('submit', actionCtx(answerRow(surface, 'ask-narrower'), cap.extra));
      await flush();
      expect(cap.calls[0]?.[0]).toBe('project-plan');
      expect(cap.calls[0]?.[1].slice(0, 6)).toEqual(['answer', ...TARGET, 'q1']);
      surface.onAction?.('approve', actionCtx(null, cap.extra));
      surface.onAction?.('dismiss', actionCtx(null, cap.extra));
      expect(cap.calls.slice(1)).toEqual([['project-plan', ['approve', ...TARGET]], ['project-plan', ['dismiss']]]);
      await flush();
      let closed = false;
      surface.onAction?.('submit', actionCtx(answerRow(surface, 'custom'), { close: () => { closed = true; } }));
      expect(closed).toBe(true);
      surface.onClose?.();
    }
  });

  test('saved questions and custom entry remain available while readiness and suggestions are pending', async () => {
    const gate = deferred();
    const state = stateWithQuestion();
    let signal: AbortSignal | undefined;
    const surface = createPlanningModalSurface({
      projectId: 'proj-1',
      service: { ...serviceWithState(state), evaluate: async () => { await gate.promise; throw new Error('synthetic unavailable'); } },
      readAnswerActions: async (_question, options) => { signal = options?.signal; await gate.promise; throw new Error('synthetic unavailable'); },
    });
    surface.onOpen?.(() => {});
    await flush();
    expect(tabText(surface.buildView(), 'planning')).toContain(state.openQuestions[0]!.prompt);
    expect(tabText(surface.buildView(), 'planning')).toContain('Reading answer suggestions');
    expect(tabText(surface.buildView(), 'planning')).toContain('blocking gaps unknown');
    expect(tabText(surface.buildView(), 'planning')).toContain('Readiness gaps have not been read.');
    expect(answerRow(surface, 'custom').selectable).not.toBe(false);
    surface.onClose?.();
    expect(signal?.aborted).toBe(true);
    gate.resolve();
    await flush();
  });

  test('closing and reopening rejects an older response and cannot repaint the closed generation', async () => {
    const { readProjectPlanningAnswerActions } = await import('@goodvibes-jev/engine/sdk/platform/knowledge');
    const first = deferred();
    const state = stateWithQuestion();
    const signals: AbortSignal[] = [];
    let calls = 0;
    let paints = 0;
    const surface = createPlanningModalSurface({
      projectId: 'proj-1', service: serviceWithState(state),
      readAnswerActions: async (question, options) => {
        signals.push(options!.signal!);
        const reading = await readProjectPlanningAnswerActions(question, options);
        if (++calls === 1) await first.promise; // Deliberately return after cancellation.
        return reading;
      },
    });
    surface.onOpen?.(() => { paints++; });
    await flush();
    surface.onClose?.();
    const closedPaints = paints;
    expect(signals[0]?.aborted).toBe(true);
    surface.onOpen?.(() => { paints++; });
    await flush();
    expect(signals[1]?.aborted).toBe(false);
    expect(answerRow(surface, 'scope-focused-first-pass')).toBeDefined();
    const currentPaints = paints;
    first.resolve();
    await flush();
    expect(paints).toBe(currentPaints);
    expect(paints).toBeGreaterThan(closedPaints);
    surface.onClose?.();
  });

  test('refresh and same-ID changed question invalidate old response and old selected rows', async () => {
    const { readProjectPlanningAnswerActions } = await import('@goodvibes-jev/engine/sdk/platform/knowledge');
    let state = stateWithQuestion();
    const service: PlanningModalService = {
      ...serviceWithState(state),
      getState: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', state, revision: REVISION }),
    };
    const gate = deferred();
    let calls = 0;
    const surface = createPlanningModalSurface({
      projectId: 'proj-1', service,
      readAnswerActions: async (question, options) => {
        const reading = await readProjectPlanningAnswerActions(question, options);
        if (++calls === 2) await gate.promise;
        return reading;
      },
    });
    surface.onOpen?.(() => {});
    await flush();
    const oldRow = answerRow(surface, 'scope-focused-first-pass');
    surface.onAction?.('refresh', actionCtx(null));
    await flush();
    state = { ...stateWithQuestion('What observations demonstrate correctness?'), updatedAt: 2 };
    installJudgmentPort(fakePort((name) => noulAnswer(name === 'verification' ? 0.99 : 0.01)).port);
    surface.onAction?.('refresh', actionCtx(null));
    await flush();
    const cap = captureCommands();
    surface.onAction?.('submit', actionCtx(oldRow, cap.extra));
    expect(cap.calls).toEqual([]);
    gate.resolve();
    await flush();
    expect(rows(surface).some((row) => row.id.endsWith(':scope-focused-first-pass'))).toBe(false);
    expect(answerRow(surface, 'verification-default-gates')).toBeDefined();
    expect(tabText(surface.buildView(), 'planning')).toContain('What observations demonstrate correctness?');
    surface.onClose?.();
  });

  test('submit rechecks the source question and revision, even when the modal has not refreshed', async () => {
    for (const change of ['question', 'revision'] as const) {
      let state = stateWithQuestion();
      const service: PlanningModalService = {
        ...serviceWithState(state),
        getState: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', state, revision: REVISION }),
      };
      const surface = await warm(service);
      const selected = answerRow(surface, 'scope-focused-first-pass');
      state = change === 'question' ? stateWithQuestion('Who chose the previous scope?') : { ...state, updatedAt: 3 };
      const statuses: string[] = [];
      const cap = captureCommands();
      surface.onAction?.('submit', actionCtx(selected, { ...cap.extra, setStatus: (status) => statuses.push(status) }));
      await flush();
      expect(cap.calls).toEqual([]);
      expect(statuses[0]).toContain('changed');
      surface.onClose?.();
    }
  });

  test('a submission whose source check resolves after close has no command or status effect', async () => {
    const gate = deferred();
    const state = stateWithQuestion();
    let reads = 0;
    const service: PlanningModalService = {
      ...serviceWithState(state),
      getState: async () => {
        if (++reads > 1) await gate.promise;
        return { ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', state, revision: REVISION };
      },
    };
    const surface = await warm(service);
    const cap = captureCommands();
    const statuses: string[] = [];
    surface.onAction?.('submit', actionCtx(answerRow(surface, 'scope-focused-first-pass'), { ...cap.extra, setStatus: (status) => statuses.push(status) }));
    surface.onClose?.();
    gate.resolve();
    await flush();
    expect(cap.calls).toEqual([]);
    expect(statuses).toEqual([]);
  });
});
